# Server Connection Add Flow and Standalone Plugin Design

**Date:** 2026-07-28
**Status:** Approved
**Scope:** Correct the primary image-connection add action and make the server plugin self-contained for standalone SillyTavern installations, including Termux.

## Problem

`#urisAddImageConn` currently creates a legacy browser-owned image connection without an explicit API type. The connection defaults to `auto`, is persisted in localforage, and is then excluded by the unified image-connection projection, which only retains server connections and the legacy Agnes/Pollinations providers. The UI therefore reports successful creation while the new card immediately disappears.

The API tab already has a separate server-draft action, `.uris-add-server-conn`, that implements the intended architecture. Keeping both actions creates conflicting semantics and duplicate controls.

Separately, the server plugin imports `uid` from the client extension outside `server-plugin/`. This works in the monorepo but fails when the plugin is copied to `SillyTavern/plugins/ur-image-studio`, including a normal Termux installation.

## Design

### Primary add action

`#urisAddImageConn` becomes the only control for adding an API image connection. It is available only when the compatible server component is available.

Clicking it appends a memory-only server draft with these defaults:

```js
{
    draftId,
    name: '',
    endpoint: '',
    apiKey: '',
    apiFamilyOverride: 'auto',
    timeoutMs: 300000,
}
```

The action performs no localforage write and no server request. The draft is rendered through the existing server connection form. A transient probe discovers routes, and the existing Save action performs `POST /connections` only after client and server validation succeed.

The duplicate `.uris-add-server-conn` control and its event handler are removed. Legacy Agnes and Pollinations cards remain visible and editable, but the primary add action no longer creates browser-owned records.

When the server component is absent or incompatible, the primary add button remains visible but disabled so the reason for unavailable creation is explicit and consistent with the existing server status message.

### Standalone server plugin

The server plugin receives a plugin-local ID generator that preserves the existing URIS identifier format accepted by server validation. Server connection services and import collision handling use this local utility instead of importing `src/core.js` from the client extension.

No server schema, API contract, storage path, or secret lifecycle changes are required.

### Termux behavior

With the standalone import fixed, Termux follows the same flow as desktop SillyTavern:

1. The browser creates a memory-only draft.
2. Probe and Save use same-origin `/api/plugins/ur-image-studio/v1/*` requests.
3. The server plugin performs provider requests from Node.js.
4. Metadata is stored below the authenticated SillyTavern user's plugin data directory.
5. Keys are stored through SillyTavern's `SecretManager`.

Prerequisites are Node.js 20 or newer, `enableServerPlugins: true`, installed plugin dependencies, and a writable Termux-private data directory. Android shared storage is not supported as the plugin data root because atomic rename and POSIX permission behavior are not reliable there.

The existing cloud endpoint policy remains unchanged: HTTPS cloud endpoints are supported; loopback and private-network provider endpoints remain blocked by SSRF protection.

## Error handling

The new draft action itself cannot fail because it mutates only module memory. Probe and Save retain the existing form-level error handling and server error envelopes. A failed Save leaves the draft and its inputs available for correction.

If the server becomes unavailable, rerendered controls are disabled and no unusable server record is persisted.

## Tests

Add regression coverage proving that:

- the primary add button creates a server draft with `auto` and `300000` defaults;
- clicking it does not add a legacy localforage record;
- clicking it does not call the server create endpoint before Save;
- only one server-add control is rendered;
- the primary add button is disabled when the server component is unavailable;
- the server plugin can be copied to an isolated standalone directory and imported without access to client source files;
- plugin-local IDs satisfy existing server connection ID validation;
- existing server form, server facade, migration, Agnes, and Pollinations tests remain passing.

## Acceptance criteria

1. Clicking `#urisAddImageConn` displays a new server connection form and the form remains visible.
2. Repeated clicks create distinct drafts rather than hidden local records.
3. No connection is persisted before successful Probe and Save.
4. The duplicate server-add button is absent.
5. Existing browser-owned Agnes and Pollinations connections remain unaffected.
6. A physically standalone server plugin loads under the documented SillyTavern plugin layout.
7. The same standalone package is usable on Termux when its stated prerequisites are met.
