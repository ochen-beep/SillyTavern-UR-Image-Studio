# Deferred queue and chat insertion

This note records intentionally deferred work for UR Image Studio 0.2.x.

## Generation queue

The queue engine exists, but the user-facing enqueue workflow is not enabled yet. A future implementation must assign an ownership generation to each worker. `Stop` may abort the current worker, but it must not reject items added after the stop action. Every item must retain its chat ID, source message ID, source-message hash, route snapshot, and requested operation.

Before a paid request, the queue must reject stale chat/message state. After dispatch starts, the UI must distinguish cancellation from an unknown provider result and must never resubmit automatically. The UI should show pending, running, skipped, cancelled, failed, and unknown-result states. Manual regeneration remains an explicit new operation.

## Lightbox to chat insertion

Insertion is specified but deliberately not enabled in the runtime UI yet. The preferred future behavior is a new assistant/character-style chat message with a native SillyTavern media attachment. It should not modify the source post, use markdown HTML, or call `saveReply` for an arbitrary gallery action.

The future adapter should:

1. Verify the current SillyTavern context exposes a mutable `chat`, `addOneMessage`, `saveChat`, `eventSource`, and `eventTypes` (with the legacy `event_types` fallback).
2. Use an already materialized native image path, or upload/localize the image before creating the message. Never persist an object URL or temporary blob URL.
3. Create `extra.media: [{ url, type: 'image', source: 'generated' }]` on a normal message object.
4. Push the message into `ctx.chat`, await `ctx.saveChat()`, emit `MESSAGE_RECEIVED`, call `ctx.addOneMessage()`, and emit `CHARACTER_MESSAGE_RENDERED`.
5. Verify persistence after chat reload, native SillyTavern media lightbox behavior, group-chat behavior, duplicate insertion behavior, and failure rollback.

`addOneMessage` and `saveChat` are source-defined, semi-public SillyTavern APIs rather than a stable extension contract. The implementation must therefore be version-gated and tested against the target SillyTavern release before exposing an "Insert into chat" lightbox action.
