# Synchronized Server Storage Design

**Date:** 2026-07-28
**Status:** Proposed
**Scope:** Cross-browser and cross-installation persistence for UR Image Studio
**Depends on:** `2026-07-27-server-image-api-connections-design.md`

## 1. Goal

Move UR Image Studio's durable user data out of browser-local IndexedDB/localforage into a server-owned store that works consistently when:

- the same SillyTavern installation is opened from Chrome, Firefox, a phone, or another browser;
- SillyTavern runs natively on Windows, Linux, macOS, or Termux;
- two separate SillyTavern installations receive identical user files through Syncthing or another file replication tool;
- either installation is temporarily offline;
- both installations are running while synchronized files arrive from the other one.

The result must remove routine browser export/import from the normal workflow. Export/import remains a disaster-recovery and portability feature, not the synchronization mechanism.

The storage design covers:

- image connections, excluding plaintext credentials from synchronized records;
- prompt templates and parameter presets;
- character and reference metadata;
- reference image files;
- prompt history and generation drafts;
- internal gallery metadata and image files;
- completed generation results;
- user-scoped settings that should follow the user;
- conflict visibility and resolution;
- migration from existing localforage records.

## 2. Non-Goals

The first implementation does not provide:

- a hosted cloud account or proprietary synchronization service;
- peer discovery or network transfer between SillyTavern installations;
- transparent synchronization of active paid provider requests;
- automatic replay of generation requests on another device;
- synchronization of browser layout, diagnostics, caches, or temporary form text;
- a general-purpose database or CRDT framework for third-party extensions;
- automatic deletion of historical data that could still arrive from an offline replica;
- encrypted multi-device credential synchronization in the initial release.

File replication is external. UR Image Studio owns the file format, merge rules, and recovery behavior, but Syncthing, cloud drive software, backup software, or the user moves the files.

## 3. Terminology

- **User root:** `req.user.directories.root` supplied by SillyTavern.
- **Replica:** one running SillyTavern server installation participating in the synchronized store.
- **Replica ID:** a random installation-scoped UUID that is not stored inside the synchronized user root.
- **Entity:** one logical user object such as a connection, template, reference, draft, or gallery entry.
- **Event:** an immutable, self-validating file describing one entity revision.
- **Head:** an event with no known child for the same entity.
- **Conflict:** two or more concurrent heads for one entity where neither descends from the other.
- **Blob:** immutable binary content addressed by SHA-256.
- **Synchronized state:** immutable events and blobs safe to replicate between installations.
- **Replica-local state:** active requests, locks, receipts, caches, diagnostics, and credentials owned by one server instance.
- **Materialized view:** replaceable replica-local projection rebuilt from synchronized events.

## 4. Core Principles

1. **The server is the persistence authority.** Browser modules access durable data only through the server plugin API.
2. **Synchronized files are immutable.** Replicas never concurrently rewrite the same normal data file.
3. **Binary data is content-addressed.** Identical images are stored once per synchronized user root.
4. **Active work has one owner.** A paid request may be executed only by the replica that claimed it.
5. **Replication is not locking.** The design remains correct without distributed locks or immediate synchronization.
6. **Conflicts are preserved.** Deterministic display selection must not destroy losing revisions.
7. **Paths are portable.** Synchronized records contain IDs and relative blob hashes, never absolute paths.
8. **Credentials are not ordinary synchronized content.** Connection metadata may synchronize; API-key availability is replica-local by default.
9. **Derived state is disposable.** A replica can rebuild indexes and projections from synchronized events.
10. **Paid requests are never inferred from file presence alone.** The durable request journal remains authoritative on its owning replica.

## 5. Storage Model Decision

### 5.1 Rejected: mutable JSON collections

Files such as `connections.json` or `gallery.json` work on one server, but two replicas can rewrite the same file independently. A file synchronization tool then creates a conflict copy or chooses one version, losing a valid update.

### 5.2 Rejected: synchronized SQLite

SQLite is suitable as a replica-local index, but its database, WAL, and SHM files must not be synchronized while either server is running. File replication cannot provide SQLite's page-level locking or transaction semantics.

### 5.3 Selected: immutable per-mutation events

Each mutation creates a uniquely named file. Independent replicas therefore create different paths rather than competing to overwrite one path. Event ancestry identifies sequential and concurrent edits. Binary data is stored as immutable content-addressed blobs.

## 6. Storage Layout

### 6.1 Synchronized user storage

The plugin derives this path only from `req.user.directories.root`:

```text
<user-root>/plugins/ur-image-studio/sync-v1/
    events/
        <entity-type>/
            <entity-shard>/
                <event-id>.json
    blobs/
        sha256/
            <first-two-hex>/
                <next-two-hex>/
                    <full-hash>.blob
```

`sync-v1` is the only directory intended for replication as application state. Replicating a larger parent directory is supported because runtime files are stored elsewhere.

### 6.2 Replica-local root

Replica-local state must not live below the synchronized user root. Resolution order:

1. explicit `URIS_LOCAL_STATE_ROOT` environment variable;
2. a SillyTavern plugin-local data/cache directory exposed by a supported host API;
3. `<SILLYTAVERN_ROOT>/.local-state/ur-image-studio/`.

The final user-scoped local directory is:

```text
<local-state-root>/
    instance.json
    user-map.json
    users/
        <stable-local-user-id>/
            requests.json
            operations.json
            import-operations.json
            journal.key
            credential-bindings.json
            encrypted-secrets.json
            materialized/
            receipts/
            diagnostics/
            temp/
```

`stable-local-user-id` comes from a stable opaque SillyTavern user ID when the host exposes one. Otherwise `user-map.json` assigns a random UUID to the authenticated username plus a set of previously observed canonical roots. A root relocation requires an explicit authenticated adoption flow that proves the old local namespace and records the new root alias; it never silently creates a fresh namespace while nonterminal requests or credentials exist. Absolute roots and usernames are stored only in this protected local map, never in synchronized files.

Startup resolves real paths for the synchronized root, local root, and every parent. Paid generation and mutations remain disabled unless the local root is proven outside the synchronized root and outside every configured replicated ancestor supplied through `URIS_REPLICATED_ROOTS`. If a larger user parent is synchronized and host secrets live within it, credential rules in section 14 apply.

If no safe writable local root can be established, the plugin reports `LOCAL_STATE_UNAVAILABLE` and disables paid generation. It must not silently place active journals inside `sync-v1`.

On Termux, the local root MUST resolve within the private app-data directory
(`/data/data/com.termux/files/home/` or equivalent) where the filesystem is ext4
with proper fsync, atomicity, and POSIX mode bits. Placing the local root on
shared/FUSE storage (e.g. under `~/storage/shared/`) voids the atomic publication
and permission assumptions in sections 7, 9, and 14. If only a shared-storage path
is writable, the plugin reports `LOCAL_STATE_UNAVAILABLE`. See also §23.1.

### 6.3 Effect on the server image API design

This specification supersedes the physical layout in the server image connection design:

- connection metadata becomes synchronized connection entities;
- request journal, operations, receipts, journal key, and credential bindings move to the replica-local root;
- completed artifacts are promoted into synchronized blobs;
- temporary artifacts remain replica-local until validated and promoted.

Public server API contracts remain versioned; storage paths are not public API.

## 7. Replica Identity and Clock

On first startup, the plugin atomically creates:

```js
{
    schemaVersion: 1,
    replicaId: crypto.randomUUID(),
    createdAt: 'ISO-8601 timestamp',
}
```

in `<local-state-root>/instance.json` with POSIX mode `0600`. The containing directory uses `0700`; Windows relies on installation-directory ACLs.

On each process start, the installation also generates an ephemeral `incarnationId`. It publishes renewable heartbeat claims under `sync-v1/claims/<replicaId>/<incarnationId>.json` containing only replica ID, incarnation ID, HLC, and expiry. Claims are advisory mutable files and are excluded from entity history and backup. Seeing historical events from one replica is normal; `REPLICA_ID_COLLISION` is raised only when two unexpired incarnation claims for one replica ID are observed after two stable scans. Managed `URIS_REPLICA_ID` deployments use the same collision protocol. An expired claim never transfers paid-request ownership.

The HLC state and local event counter are updated under one replica-local mutex and persisted atomically before event publication. On remote intake, local HLC advances to `max(local, remote)` according to the HLC algorithm before the next local event. On crash, startup scans this replica's visible events and advances the local clock/counter beyond their maximum before writes are enabled. Randomness protects uniqueness but is not used to establish monotonicity.

## 8. Event Format

Every event is one bounded UTF-8 JSON file:

```js
{
    schemaVersion: 1,
    eventId: 'sortable-unique-event-id',
    entityType: 'connection',
    entityId: 'stable-entity-id',
    operation: 'upsert', // 'upsert' | 'delete' | 'merge'
    parents: ['event-id'],
    replicaId: 'uuid',
    hlc: 'physicalMillis:logicalCounter:replicaId',
    createdAt: 'ISO-8601 timestamp',
    payload: {},
    payloadHash: 'sha256-hex',
}
```

### 8.1 Event ID

Event IDs are lexically sortable and globally unique. They combine current milliseconds, replica identity, a monotonic local counter, and cryptographic randomness. Filenames must match a strict ASCII pattern.

### 8.2 Parents and graph validity

- a new entity has `parents: []`;
- a normal edit names every head known to the editor for that entity;
- a conflict-resolution merge names all heads being resolved;
- every resolved parent must have the same `entityType` and `entityId` as its child;
- no event may name itself or contain duplicate parents;
- bounded depth-first validation rejects cycles and ancestry exceeding the configured limit;
- missing parents are tolerated temporarily because files may arrive out of order;
- an event with any missing or invalid ancestor, and all descendants depending on it, remain `incomplete` and are excluded from heads, conflict selection, and normal entity projections;
- intake retries incomplete graphs whenever any new event arrives; absence beyond the diagnostic interval raises `EVENT_INCOMPLETE` but does not delete files.

### 8.3 Payload

`upsert` and `merge` carry the complete normalized entity, not an ad hoc patch. `delete` carries bounded deletion metadata:

```js
{
    reason: 'user-delete' | 'migration' | 'retention',
}
```

### 8.4 Integrity

`payloadHash` is SHA-256 over RFC 8785 JSON Canonicalization Scheme bytes for `{ schemaVersion, eventId, entityType, entityId, operation, parents, replicaId, hlc, createdAt, payload }`; `payloadHash` itself is excluded to avoid circular input. Input is normalized to JSON-compatible values before canonicalization: no `undefined`, non-finite numbers, duplicate object keys, or implementation-dependent date objects. Parent arrays preserve their semantic sorted lexical order. The filename event ID must equal the envelope event ID. Invalid, oversized, or inconsistent events are excluded from materialization and reported through diagnostics.

Integrity hashes detect partial writes and accidental corruption; they are not signatures and do not defend against a malicious process with write access to the user root.

## 9. Atomic File Publication

To publish an event or blob, first run a startup capability check on its actual destination filesystem. Writes are disabled if the plugin cannot demonstrate same-directory temporary creation, file flush, atomic same-directory rename, destination identity verification, and safe handling of symlinks/reparse points.

Publication uses a capability-selected no-replace primitive; ordinary overwrite-capable `rename()` is forbidden for final publication:

1. validate and canonicalize content;
2. create and fully write/fsync a hidden random sibling using exclusive creation;
   on FUSE-backed shared storage (e.g. Android Termux `~/storage/shared/`),
   fsync may be a no-op or provide weaker durability; the startup capability
   check (§9 preamble) reports the filesystem class, and for degraded
   filesystems the protocol relies on capability-tested no-replace primitives
   and byte-compare fallback (see §23.1);
3. on POSIX-like filesystems, publish with `link(temp, final)`: hard-link creation fails atomically with `EEXIST` and cannot replace the final path, then unlink the temp name;
4. on Linux where hard links are unavailable but `renameat2(RENAME_NOREPLACE)` is capability-tested through a narrowly scoped native/host bridge, that primitive may be used;
5. on Windows, publish with a capability-tested create-new/copy primitive equivalent to `CREATE_NEW` (`COPYFILE_EXCL` from the fully written sibling); never call replacement-capable MoveFile/rename for the final name;
6. if no tested no-replace primitive works on the actual synchronized filesystem, the store is read-only with `STORE_ATOMIC_PUBLISH_UNAVAILABLE`;
7. if final destination already exists, reopen it and verify complete byte/hash identity: identical means idempotent success, different means immutable-name collision and disables that entity/blob;
8. sync the containing directory on POSIX where supported (on Android
   FUSE shared storage, directory fsync may return success without
   guaranteeing durability; see §23.1); on Windows close all handles and
   treat sharing/reparse failures as retryable without weakening path checks.

Per-process mutexes reduce local duplicate work but are not part of cross-process correctness. Syncthing or another process racing publication can win exclusive destination creation, but can never be overwritten by plugin publication.

Readers ignore hidden files, `.tmp` files, Syncthing temporary names, conflict copies that fail the strict filename grammar, and files still changing in size. A candidate that fails parse/hash validation is not permanently marked known: intake records its observed size/mtime and retries after any metadata change and during periodic repair scans. Only a stable unchanged invalid file increments durable diagnostics.

Malformed files are not moved automatically because moving them is itself a synchronized mutation. Diagnostics expose them; explicit repair tooling may copy them to a quarantine area with a report.

## 10. Materialization and Replication Intake

Each replica maintains a replaceable local projection from events. Intake tracks `pending`, `valid`, `incomplete`, and `stable-invalid` files separately. A parse/hash failure never adds the event ID to the valid/known set. Arrival of a missing parent, metadata change, explicit Refresh, and startup scan all retry pending or incomplete candidates.

### 10.1 Intake loop

Use `fs.watch` only as a latency hint. Correctness comes from bounded periodic scans because recursive watcher behavior differs across Windows, Linux, Android/Termux, network filesystems, and synchronization tools.

The loop:

1. scans event shard metadata;
2. identifies unknown event IDs;
3. waits until candidate size and mtime are stable across two observations;
4. validates filename, size, JSON schema, hash, and payload limits;
5. adds valid events to the local event index;
6. recalculates only affected entity heads;
7. emits an internal `store-changed` notification for connected browsers.

Default scan interval is five seconds while clients are connected and thirty seconds while idle. UI also provides explicit Refresh.

### 10.2 Materialized view

The local projection may use sharded atomic JSON files. A future local SQLite index
is allowed only if it remains entirely outside `sync-v1`, can be deleted and rebuilt
without data loss, and does not require native compilation on Termux (use a pure-JS
SQLite implementation or make the native dependency optional with a JSON-file
fallback; see §23.1.3).

Materialized state is never authoritative and never proves that a paid request was dispatched.

### 10.3 Rebuild

On corrupt or missing local index:

- preserve the bad index for diagnostics;
- scan all valid synchronized events;
- rebuild ancestry, heads, selected projections, conflicts, and blob references;
- keep the store API read-only during rebuild;
- expose progress through `/v1/store/status`;
- enable writes only after a consistent view of currently visible files exists.

## 11. Merge and Conflict Semantics

### 11.1 Causality

If event B directly or transitively names event A as a parent, B supersedes A. Wall-clock order cannot override ancestry. If neither event descends from the other, they are concurrent heads.

### 11.2 Deterministic selected head

For ordinary reads, select one head by:

1. greatest HLC;
2. lexical replica ID;
3. lexical event ID.

This gives identical visible state after replicas receive identical files. Non-selected heads remain stored.

### 11.3 Conflict projection

Safe projection includes:

```js
{
    revision: 'selected-event-id',
    conflicted: true,
    conflictHeads: [
        { eventId, replicaId, createdAt, summary },
    ],
}
```

Sensitive payloads are excluded from summaries. A connection summary may show endpoint host, model, and changed field names, never a credential.

### 11.4 Resolution

User resolution selects one payload or submits a merged payload. Server emits a `merge` event naming all current heads as parents. A later concurrent event may create a new conflict.

### 11.5 Optimistic concurrency

Mutation requests include `expectedHeads`. If current heads differ, server returns `ENTITY_REVISION_CONFLICT` with safe head metadata. Blind writes are allowed only for append-only entity types with new entity IDs.

## 12. Entity Catalog

Each entity type has its own schema, payload limit, conflict policy, and blob-reference extractor.

### 12.1 Connections

```js
{
    id,
    kind: 'image',
    name,
    endpoint,
    apiFamilyOverride,
    modelRouteId,
    selectedRoute,
    timeoutMs,
    createdAt,
    updatedAt,
}
```

Excluded fields:

- API key;
- SecretManager ID;
- `hasApiKey`, because availability differs by replica;
- remote catalog payload;
- probe receipt;
- local operation state.

The authoritative route snapshot required for generation is `selectedRoute` in the synchronized connection event. It contains the exact route ID, family, model, sanitized adapter routing metadata, and conservative capabilities accepted at save time. Replica-local catalogs may refresh labels/capabilities for UI, but never silently replace this snapshot; accepting a refreshed route emits a new connection revision. A missing or conflicted route blocks generation.

### 12.2 Prompt templates

Each template is one entity. Concurrent edits expose alternate revisions. Built-in templates remain code-owned unless copied into a user template.

### 12.3 Parameter presets and characters

Each preset and character is independent. Folder/order data uses stable IDs and numeric sort fields; reordering does not rewrite one shared list.

### 12.4 Reference folders

Each folder is one entity. Folder deletion does not delete references; references with a missing or deleted folder appear as unfiled.

### 12.5 References

```js
{
    id,
    name,
    role,
    folderId,
    tags,
    blob: {
        algorithm: 'sha256',
        hash,
        mimeType,
        byteLength,
        width,
        height,
    },
    createdAt,
    updatedAt,
}
```

The existing SillyTavern image path is not authoritative after migration. Migration ingests bytes into the blob store. Missing source files produce an explicit warning, not a broken absolute path.

### 12.6 Prompt history

Each history item is an append-only entity with chat ID, message ID, prompt, settings summary, and timestamps. Clearing history emits tombstones or a scoped cutoff entity; it does not rewrite one shared array.

### 12.7 Generation drafts

Draft identity remains chat ID plus source message ID. Payload contains prompt, instruction settings, reference IDs/corrections, Stage 1 context, and last immutable Stage 2 snapshot.

Drafts use ordinary conflict handling. A conflicted draft cannot start Stage 2 until resolved. Draft payloads reference blobs by ID/hash and never duplicate data URLs.

### 12.8 Gallery entries

```js
{
    id,
    chatId,
    sourceMessageId,
    blob: {
        algorithm: 'sha256',
        hash,
        mimeType,
        byteLength,
        width,
        height,
    },
    promptSnapshot,
    referenceIds,
    connectionId,
    modelRouteId,
    generationRequestId,
    createdAt,
    annotations,
}
```

Gallery insertion is append-only with a new ID. Annotation changes are revisions. Delete emits a tombstone. Browser does not store gallery data URLs after migration.

### 12.9 User-scoped preferences

Synchronized preferences include:

- default template/preset IDs;
- generation defaults;
- automation policy;
- reference-selection policy;
- gallery policy;
- server connection selection fallback.

Local-only preferences include:

- panel geometry and collapsed state;
- active tab and scroll position;
- diagnostics/netdump;
- temporary form input;
- polling/cache timing;
- per-replica key availability.

Chat-specific selection stays in SillyTavern chat metadata because chat files already belong to SillyTavern data. Metadata stores stable entity IDs only.

### 12.10 Legacy bundles and deprecated profiles

Legacy bundles are migration inputs, not synchronized entities. Migration expands them into current entities and bindings. Deprecated reference profiles are not synchronized.

## 13. Blob Store

### 13.1 Ingestion

Images are validated header-first, then decoded, then hashed:

1. **Header-only parse** — extract width, height, and pixel count from the
   image header (PNG IHDR, JPEG SOF₀, WebP VP8, GIF logical screen descriptor)
   without decoding pixel data. Reject images exceeding the pixel-count limit
   at this stage, before any pixel buffer allocation. This protects against
   decompression bombs and OOM under Termux memory constraints.
2. **Full decode and validate** against:
   - bounded encoded and decoded sizes;
   - supported MIME allowlist;
   - magic-byte verification;
   - image dimension confirmation (matches header values);
   - supported pixel format;
   - controlled extension derived from validated MIME;
   - no caller-provided path or extension.

Header-only parsing must use pure-JS parsers (pngjs, jpeg-js, or inline header
reading) that install without native compilation on Termux (see §23.1.3).

Hash is SHA-256 over exact stored bytes.

### 13.2 Deduplication

If a valid blob already exists at the expected hash path, upload is idempotent. A hash-path file whose bytes do not match its name is corruption and blocks use.

### 13.3 Reads

Blob API resolves exactly `blobs/sha256/<shard>/<hash>.blob`; the URL never contains or discovers an extension. It reads and validates the blob header/magic bytes, then obtains MIME from validated materialized blob metadata and cross-checks it against bytes. Conflicting metadata blocks the read. Response uses authenticated same-user access, safe content type, `X-Content-Type-Options: nosniff`, and immutable cache headers keyed by hash.

An entity event may arrive before its referenced blob. Such an entity remains a valid synchronized revision but projects `blobState:'missing'`; UI shows metadata and a pending synchronization state, and generation/reference delivery cannot consume it. Intake automatically reprojects it when the blob arrives. Local entity creation still requires an existing validated blob or an atomic domain publication operation.

### 13.4 Promotion of generated results

The finalization owner changes only when synchronized gallery storage is enabled. The server, not Stage 2 browser code, owns completed-result publication. For every paid request it derives:

```text
galleryEntityId = UUIDv5(URIS_GALLERY_NAMESPACE, ownerReplicaId + ':' + requestId)
galleryCreateEventId = deterministic hash/encoding of ownerReplicaId + requestId + resultBlobHash
```

Before publication, the exact canonical gallery event envelope is written into the local request journal as `preparedGalleryEvent`. Deterministic constructor fixes every byte:

- `eventId` from UUIDv5/hash above;
- `entityType:'gallery'`, deterministic entity ID, `operation:'upsert'`, `parents:[]`;
- `replicaId:ownerReplicaId`;
- HLC and `createdAt` copied from the original durable request claim timestamp/clock, not current retry time;
- normalized payload copied from the immutable result/request snapshot;
- hash computed once from those fields.

Retries and startup reconciliation republish these stored canonical bytes verbatim. If a same-name event differs, request enters `failed-ambiguous-storage` and no alternate gallery ID is created.

The owning replica:

1. receives provider result into local temporary storage;
2. validates MIME, magic bytes, dimensions, and size;
3. persists local request journal state `result-received` with result hash/metadata;
4. publishes the synchronized blob idempotently;
5. before publishing gallery, searches materialized/events by deterministic gallery entity ID and verifies request/blob identity;
6. publishes the deterministic root gallery event idempotently if absent;
7. records gallery entity/event IDs in the local journal;
8. transitions request to `ready`;
9. returns `{ kind:'gallery', galleryEntry, blobUrl }` from `/generate` and `/requests/:id`.

A crash at any boundary is reconciled by deterministic IDs. Startup checks the journal plus synchronized event index before republishing; the same `(ownerReplicaId, requestId)` cannot create a second gallery entity.

During migration, API capability `generationResultMode` is explicit:

- `data-url-v1`: old server response; browser `savePendingImage/processPending` creates the legacy gallery item;
- `server-gallery-v1`: server returns the canonical gallery projection; browser updates the draft and clears its request pointer but must not call legacy gallery insertion.

Compatibility is negotiated per request, not inferred only from status. New clients send `resultMode:'server-gallery-v1'` in `POST /generate`; that value is included in the request fingerprint and persisted journal. Clients that omit it receive `data-url-v1`, which is the mandatory backward-compatible default. `GET /requests/:id` returns the mode stored at claim time and never changes representation after server upgrades. A request ID reused with another mode produces `REQUEST_ID_CONFLICT`. `/v1/status` only advertises supported modes so the client knows whether it may opt in. Enabling opt-in requires migrated gallery reads and Stage 2 tests proving exactly one entry.

### 13.5 Garbage collection

Automatic physical blob deletion is out of scope for the first release. Tombstoned entities stop displaying blobs, but bytes remain for offline replicas and recovery.

UI reports logical usage, orphan candidates, and physical usage. A future explicit Vacuum operation requires a complete event scan and a user-confirmed offline-replica policy.

## 14. Credentials

### 14.1 Default model

Connection metadata synchronizes; API keys do not. The plugin may use SillyTavern SecretManager only after a host capability check proves the backing secret path is outside `sync-v1` and every configured replicated ancestor. Otherwise it uses `encrypted-secrets.json` in replica-local state, encrypted with a random 256-bit installation key stored in the OS credential facility when available or in a mode-`0600` local key file outside replicated roots. AES-256-GCM uses a fresh nonce per secret and authenticates `{stableLocalUserId, slot}`. If neither backend can establish local-only storage, key persistence is disabled with `LOCAL_SECRET_STORE_UNAVAILABLE`; the plugin never writes plaintext fallback credentials.

Each replica stores a local binding:

```js
{
    slot: 'connection:<connection-id>',
    secretId: 'opaque-local-secret-manager-id',
    updatedAt,
}
```

The secret remains in the selected verified local secret backend. Projection adds:

```js
{
    hasApiKey: true | false,
    credentialScope: 'replica-local',
}
```

A connection arriving on a new replica is visible but keyless until the user enters a key. Existing local keys are never overwritten by synchronized metadata.

### 14.2 Host secret files

At startup the host bridge resolves the real SecretManager backing path through a supported host API or a verified compatibility adapter. If the path cannot be determined, or falls under `sync-v1`/`URIS_REPLICATED_ROOTS`, SecretManager is not used for new plugin secrets. Existing secrets there are reported as `credentialScope:'host-replicated-legacy'` and generation remains available only during migration to the local backend; the plugin never claims they are replica-local. Operators who intentionally synchronize host secret files receive a persistent warning because host-level conflicts remain outside this protocol.

### 14.3 Future encrypted vault

Encrypted multi-replica credentials require a separate design covering passphrase derivation, authenticated encryption, rotation, recovery, and key erasure. No placeholder encryption is introduced here.

## 15. Paid Generation and Replica Ownership

### 15.1 Local authority

Paid-request journal is replica-local:

```js
{
    requestId,
    ownerReplicaId,
    fingerprint,
    state,
    connectionId,
    resultBlobHash: null,
    galleryEventId: null,
    createdAt,
    updatedAt,
}
```

Only `ownerReplicaId` may dispatch or resume provider-result download. Claim atomically pins an immutable execution snapshot in the local journal: connection revision/event ID, selected route, normalized settings, reference hashes, prompt hash, and a credential-version binding. The secret backend retains the referenced credential version while any nonterminal request uses it. Synchronized connection edits or tombstones affect new requests only; they never cancel, mutate, or erase an in-flight request. Connection/key deletion becomes a deferred cleanup marker until all referencing local journals are terminal and their result recovery retention has completed. Replicated events never delete local journals, temporary artifacts, or credential versions.

### 15.2 Synchronized job status

Before dispatch, owner may emit a bounded `generation-job` entity:

```js
{
    requestId,
    ownerReplicaId,
    chatId,
    sourceMessageId,
    state: 'owned' | 'ready' | 'failed' | 'ambiguous',
    createdAt,
    updatedAt,
}
```

It excludes prompt text, references, credentials, provider URLs, and journal fingerprint. It informs UX but never authorizes execution.

### 15.3 Remote-replica behavior

- `ready` with available gallery/blob opens normally;
- `owned` shows that completion is pending elsewhere;
- `ambiguous` warns that retry is unsafe;
- no synchronized state triggers `/generate` automatically;
- a new generation requires a new request ID and explicit user action.

There is no automatic ownership takeover. A lost owner cannot prove to another replica that request bytes were never sent.

## 16. Server API

All endpoints remain under:

```text
/api/plugins/ur-image-studio/v1
```

### 16.1 Status

```text
GET /store/status
```

```js
{
    schemaVersion: 1,
    replicaId,
    state: 'ready' | 'rebuilding' | 'read-only' | 'error',
    lastScanAt,
    pendingFileCount,
    invalidFileCount,
    conflictCount,
    synchronizedRootAvailable,
    localRootAvailable,
}
```

Absolute paths are never returned.

### 16.2 Queries

```text
GET /store/entities/:entityType
GET /store/entities/:entityType/:entityId
```

Lists use bounded cursor pagination, per-type filters, deleted/conflicted filters, and stable sorting.

### 16.3 Mutations

```text
POST   /store/entities/:entityType
PUT    /store/entities/:entityType/:entityId
DELETE /store/entities/:entityType/:entityId
POST   /store/entities/:entityType/:entityId/resolve
```

Body includes normalized payload and `expectedHeads`. Server assigns event ID, replica ID, HLC, timestamps, hashes, and parents. Browser cannot choose paths or forge authorship.

### 16.4 Conflicts

```text
GET /store/conflicts
GET /store/conflicts/:entityType/:entityId
```

Conflict detail returns payloads only to the authenticated owner and applies ordinary limits. Credentials never exist in event payloads.

### 16.5 Blobs

```text
POST /store/blobs
GET  /store/blobs/sha256/:hash
HEAD /store/blobs/sha256/:hash
```

Entities may reference only validated existing blobs unless an atomic domain endpoint publishes blob and event together.

### 16.6 Change notification

Initial release uses in-page events after local mutations and bounded polling:

```text
GET /store/changes?after=<token>
```

SSE may be added later. Correctness never depends on a long-lived browser connection.

### 16.7 Retained domain APIs and version negotiation

The generic store API does not replace domain validation endpoints. These remain authoritative:

```text
POST   /connections/probe
POST   /connections/:connectionId/probe
POST   /connections
PUT    /connections/:connectionId
DELETE /connections/:connectionId
POST   /connections/:connectionId/key
DELETE /connections/:connectionId/key
POST   /generate
GET    /requests/:requestId
```

Connection create/update validates probe receipts/manual routes, then emits connection events through the store service. Key endpoints touch only replica-local credentials and never emit events unless connection metadata also changes. Probe catalogs stay replica-local; accepting a route writes its sanitized snapshot into a connection revision. `/generate` resolves the pinned connection revision and returns according to advertised `generationResultMode`. `/requests/:id` remains owner-journal recovery authority and may return a synchronized ready gallery projection after reconciliation.

`GET /v1/status` advertises `storeSchemaVersion`, `entityApiVersion`, `generationResultMode`, and migration state. Clients lacking `server-gallery-v1` continue the legacy data-url pipeline until gallery migration is complete; incompatible versions fail explicitly rather than guessing.

## 17. Browser Client Model

Browser code uses one `server-store-api.js` facade. Domain modules do not access localforage for migrated durable entities.

```js
listEntities(type, options)
getEntity(type, id)
createEntity(type, payload)
updateEntity(type, id, payload, expectedHeads)
deleteEntity(type, id, expectedHeads)
resolveEntityConflict(type, id, payload, expectedHeads)
uploadBlob(file)
getBlobUrl(hash)
getStoreStatus()
getChanges(token)
```

Browser-local storage is allowed only for:

- unsaved form drafts without credential persistence;
- UI layout state;
- short-lived response caches;
- pending client pointers associating UI actions with server journals;
- migration checkpoints until server read-back succeeds.

Server projections are authoritative. Client invalidates caches when the change token advances.

## 18. Migration

Migration is incremental, idempotent, and category-based. It never deletes localforage data before server read-back proves equivalent durable state exists.

### 18.1 Preflight

- server plugin and schema are compatible;
- synchronized and local roots are writable;
- replica identity is valid;
- materialization is complete;
- browser obtains a server-issued migration operation ID;
- read-only inventory records counts, IDs, and missing images.

### 18.2 Order

1. migrate any existing server-plugin v1 state described in section 18.2.1;
2. connections through the existing browser connection migration;
3. templates, presets, characters, folders, and reference metadata;
4. reference image bytes;
5. prompt histories and generation drafts;
6. internal gallery images and entries;
7. synchronized preferences;
8. stable chat-binding verification;
9. browser-local cleanup.

#### 18.2.1 Existing server-plugin v1 migration

Before `sync-v1` becomes writable, the server inventories legacy plugin files under the user root: `connections.json`, `requests.json`, `operations.json`, `import-operations.json`, `journal.key`, and `artifacts/`. Under one resumable local migration operation it:

1. places legacy public APIs in maintenance/read-only mode;
2. reconciles legacy connection operations first;
3. creates synchronized connection root events with preserved IDs and sanitized selected routes;
4. reads each embedded `secretId`, verifies the secret exists, copies/rewraps it into the verified replica-local secret backend, creates credential binding, and verifies read-back without exposing value;
5. classifies every legacy request before copying it:
   - terminal requests may be imported by any replica because they cannot dispatch;
   - `dispatching`, `upstream-accepted`, `result-received`, and unknown nonterminal states become local `failed-ambiguous` records and can never dispatch again;
   - `claimed` and `not-dispatched` are not adopted automatically when the legacy root may be visible to multiple replicas; they become `migration-adoption-required` and generation remains read-only for those request IDs;
   - an authenticated user may perform one-time adoption only after all other SillyTavern replicas using that synchronized root are stopped and synchronization is complete; adoption publishes an immutable synchronized `legacy-request-adoption` record with deterministic request identity and chosen owner replica, then imports as `not-dispatched`;
   - if multiple different adoption records ever appear, the request becomes `failed-ambiguous` permanently;
   exact request IDs, fingerprints, and result metadata are preserved;
6. moves reconciled operation markers, import operations, and journal key into the stable local namespace;
7. validates legacy artifacts, promotes terminal completed results through deterministic gallery IDs, and keeps unresolved provider URLs/artifacts local;
8. reconstructs services from new roots and verifies connection projections, credential availability, request status, and artifacts;
9. atomically marks migration committed locally;
10. renames legacy mutable files to a non-authoritative `.migrated-v1` archive outside `sync-v1`; physical deletion requires later explicit cleanup.

A crash resumes by operation phase. The plugin never operates both legacy and new journals as authorities. If an existing nonterminal journal cannot be assigned safely to the current replica/local namespace, generation remains read-only with `SERVER_V1_MIGRATION_BLOCKED`.

Pending active browser generations are not bulk-migrated into synchronized authority. They finish on their owning replica or remain in legacy recovery until finalized/discarded.

### 18.3 Identity

Existing stable IDs are preserved. Items without IDs receive deterministic IDs derived from category plus canonical legacy fingerprint so reruns do not duplicate data.

### 18.4 Images

Gallery data URLs are decoded and uploaded. SillyTavern image paths are fetched through authenticated server facilities and validated. Missing files produce warnings tied to entities; metadata is not falsely marked complete.

### 18.5 Verification and cleanup

For each category:

```text
inventory
→ create events/blobs
→ force rescan/materialization
→ read safe projections
→ compare IDs, counts, hashes, and references
→ mark category verified
→ remove only that category's browser data
```

Failure preserves source data and already-created idempotent events. Restart resumes from operation state.

### 18.6 Multiple browser or replica migrations

For every legacy item, migration computes `migrationKey = SHA-256(sourceSchema + category + stableEntityId + canonicalPayload)`. A deterministic migration constructor fixes the complete event bytes, not only the filename:

```js
{
    eventId: uuidV5(URIS_MIGRATION_EVENT_NAMESPACE, migrationKey),
    entityType,
    entityId,
    operation: 'upsert',
    parents: [],
    replicaId: '00000000-0000-5000-8000-000000000001',
    hlc: `0:${uint53FromHash(migrationKey)}:migration-v1`,
    createdAt: legacyCreatedAtOrEpochNormalized,
    payload: normalizedCanonicalPayload,
}
```

The fixed replica UUID is reserved and rejected for ordinary event authorship. `legacyCreatedAtOrEpochNormalized` is derived deterministically from normalized source data, falling back to `1970-01-01T00:00:00.000Z`; it never uses migration runtime. The complete prepared envelope and its RFC 8785 bytes are persisted in the local migration operation before publication, and retries publish those bytes verbatim. The synchronized receipt uses the same rule with its own namespace. Publishing the same migration on two replicas therefore targets the same immutable filename with identical bytes.

If two sources map the same stable entity ID to byte-identical payloads, materialization semantically coalesces their migration roots even if an older implementation produced different event IDs. If payloads differ, they remain true concurrent conflicts. Tests crash after blob publication, root event publication, receipt publication, read-back, and browser cleanup; rerun must neither duplicate entities nor delete unverified source data.

### 18.7 Legacy export/import

Backup remains available during transition. After migration, complete backup is a server archive containing logical entities and referenced blobs. Browser JSON is compatibility-only.

## 19. Backup and Restore

Synchronization is not backup. Deletion or corruption can propagate.

Server archive:

- inventories valid events and referenced blobs consistently;
- includes schema/version metadata and checksums;
- excludes local journals, operations, credentials, diagnostics, and caches;
- streams without loading all blobs into memory;
- verifies archive before reporting success.

Restore imports immutable files idempotently and rebuilds projections. Restoring into a non-empty store may intentionally create conflicts. Credentials require separate SillyTavern backup or re-entry.

## 20. Security

### 20.1 Isolation and paths

- derive user root only from authenticated `req.user.directories.root`;
- derive local user namespace from a stable host user ID or protected root-alias mapping from section 6.2;
- reject browser-supplied absolute paths and filenames;
- validate entity type through a static registry;
- validate IDs before path construction;
- prevent traversal, symlink, junction, and reparse-point escape;
- do not follow synchronized symlinks;
- verify resolved destinations remain below configured roots.

### 20.2 Limits

Hard limits apply to:

- event JSON bytes;
- payload depth, string lengths, and array cardinality;
- events processed per scan;
- ancestry traversal;
- conflict heads per entity;
- blob encoded/decoded bytes;
- image dimensions and pixels;
- pagination;
- migration batches;
- archive size/duration.

An entity exceeding conflict-head limits becomes read-only with `ENTITY_CONFLICT_LIMIT`.

### 20.3 Logging

Never log:

- API keys or secret IDs;
- auth headers;
- full prompts by default;
- reference/gallery bytes or data URLs;
- signed provider URL query strings;
- full absolute user paths;
- raw corrupt event payloads.

Diagnostics may use event IDs, entity IDs/types, replica IDs, safe field names, sizes, hashes, and diagnostic IDs.

### 20.4 Trust model

The design protects against accidental conflicts, partial writes, malformed replicated files, path attacks, and browser attempts to bypass server validation.

It does not protect confidentiality or integrity from a process or synchronization peer with unrestricted write access to the same user directory. Signed/encrypted replication is separate scope.

## 21. Error Handling

Stable codes:

```text
STORE_UNAVAILABLE
LOCAL_STATE_UNAVAILABLE
LOCAL_SECRET_STORE_UNAVAILABLE
STORE_REBUILDING
STORE_READ_ONLY
STORE_ATOMIC_PUBLISH_UNAVAILABLE
REPLICA_ID_COLLISION
EVENT_INVALID
EVENT_INCOMPLETE
ENTITY_NOT_FOUND
ENTITY_DELETED
ENTITY_REVISION_CONFLICT
ENTITY_CONFLICT_LIMIT
ENTITY_SCHEMA_INVALID
BLOB_NOT_FOUND
BLOB_INVALID
BLOB_TOO_LARGE
MIGRATION_INCOMPLETE
MIGRATION_SOURCE_MISSING
SERVER_V1_MIGRATION_BLOCKED
GENERATION_OWNED_BY_OTHER_REPLICA
```

Errors use the existing safe envelope: `code`, safe `message`, `retryable`, and `diagnosticsId`. Retrying a store read is distinct from retrying a paid generation request.

## 22. Retention and Deletion

Logical deletion emits a tombstone. Normal APIs hide deleted entities but preserve ancestry.

First-release policy:

- events are never deleted automatically;
- synchronized blobs are never deleted automatically;
- local caches and diagnostics may use bounded retention;
- completed local request journals may be removed only after synchronized gallery publication is verified and recovery policy permits it;
- unresolved or ambiguous paid requests remain local until explicit action or a separately specified administrative policy.

Compaction, replica acknowledgements, and distributed garbage collection require a later specification.

## 23. Compatibility and Deployment

Supported environments:

- Node.js supported by the server image plugin, currently Node >=20;
- Windows/NTFS;
- conventional Linux filesystems;
- Android Termux storage where atomic publication is tested;
- synchronized folders with eventual ordinary-file replication.

The plugin detects and reports:

- read-only roots;
- case-insensitive filename collisions;
- unsupported symlinks/reparse points;
- missing rename guarantees;
- unstable writes;
- excessive path lengths;
- replica identity collision.

The protocol does not assume identical paths, usernames, drive letters, or separators.

### 23.1 Termux-Specific Constraints

Running a SillyTavern Node.js server under Termux on Android introduces
constraints that differ from desktop/server Linux and inform every layer
of this design.

#### 23.1.1 Storage dichotomy: private ext4 vs shared FUSE

Termux offers two filesystem realms with opposite properties:

- **Private app-data** (`/data/data/com.termux/files/home/`): real ext4
  filesystem. Supports atomic rename, reliable fsync, POSIX mode bits,
  case-sensitive names, and inotify. **Not accessible** to other Android
  apps or file-replication tools under Android 11+ scoped storage.
- **Shared storage** (`~/storage/shared/` via `termux-setup-storage`):
  FUSE-mounted virtual filesystem visible to other apps, Syncthing,
  and file managers. **Does not** guarantee atomic rename, fsync may be a
  no-op, mode bits (`0600`/`0700`) are ignored, inotify is absent,
  directory fsync is unsupported, and hard links are typically unavailable.

This design needs both realms: synchronized content must be reachable by
external replication tools (may use shared storage), while local state
journals, keys, and credential bindings must not leak through absent
mode bits (needs private ext4). Therefore:

- `sync-v1/` may reside on either realm depending on the user's
  replication setup. The startup capability check (§9 preamble) reports
  the detected filesystem class and, for shared FUSE, emits
  `FS_FUSE_DEGRADED` with a warning that no-replace primitives fall back
  through §9 steps 3→4→6. If both `link()` and `renameat2(RENAME_NOREPLACE)`
  are unavailable, the store becomes read-only with
  `STORE_ATOMIC_PUBLISH_UNAVAILABLE`. This is an expected degradation on
  FUSE, not a bug.
- `<local-state-root/>` MUST reside on private ext4. If the resolved
  local root lands on shared/FUSE storage, the plugin reports
  `LOCAL_STATE_UNAVAILABLE` and disables paid generation.
- exFAT/FAT32 external SD cards provide neither atomic rename,
  hard-link, nor POSIX file-locking semantics and are **unsupported**
  as `sync-v1` roots. The capability check rejects them with
  `FS_UNSUPPORTED`.

#### 23.1.2 Phantom Process Killer and process lifecycle

Android 12+ includes a Phantom Process Killer (PPK) that limits child
processes across all applications to 32 total. Termux shell processes,
including Node.js servers, are killed with SIGKILL when the limit is
exceeded. Additionally, Doze and app standby suspend background Termux
processes when the screen is off.

Consequences for this design:

- The server process may be killed **during** event publication (§9),
  blob promotion (§13.4), or paid-generation dispatch (§15). The
  publication protocol must survive partial writes: the intake loop
  (§10.1) treats stable-unchanged invalid files as diagnostics, and
  files tombstoned by a crash remain retryable non-events.
- Active paid-request ownership (§15) is lost without cleanup on PPK
  kill. The `owned`/`ambiguous` state is therefore the **normal**
  outcome on Termux, not a rare crash. Section 15.3 remote-replica
  behavior applies; section 22 retention requires a future
  administrative policy addressing mobile stuck-owner recovery
  explicitly.
- The intake loop (§10.1) cannot run while the process is killed.
  Replicated files accumulate but are not ingested until the user
  relaunches Termux and the server restarts. The first scan after
  restart processes the backlog. This is by design but differs from
  desktop where the server typically remains running.

Operational requirements for Termux users (not enforced by the plugin):

- `termux-wake-lock` to prevent suspend during screen-off.
- Termux:Boot plugin to auto-start the server after device reboot.
- Disabling PPK via ADB (`device_config put activity_manager
  max_phantom_processes 2147483647`) or per-app process limit override
  is recommended for acceptable reliability.
- Battery-optimisation exemption for Termux (Android Settings).

The plugin should detect PPK-induced kills via incarnation expiry (§7)
and surface them in `/store/status` as `lastIncarnationKilledAt`.

#### 23.1.3 Native Node.js modules

npm packages with native C/C++ addons (`better-sqlite3`, `sharp`,
`canvas`, `bcrypt`, `argon2`) ship prebuilt binaries for glibc Linux,
macOS, and Windows. They do **not** ship prebuilts for
`aarch64-linux-android` (Android bionic libc). Installation on Termux
falls back to source compilation, which requires `clang`, `python`,
`make`, and matching system headers.

Design rules:

- The default dependency tree must install without native compilation
  on Termux. Pure-JS image-header parsers (pngjs, jpeg-js, or inline
  header reading) replace sharp for header-first validation (§13.1).
- A future local SQLite index (§10.2) must use a pure-JS SQLite
  implementation or make the native dependency optional with a JSON-file
  fallback.
- If an optional native module is offered (e.g. sharp for full-decode
  performance), Termux users must be able to omit it without feature loss.

#### 23.1.4 Mobile networking caveats

SillyTavern served from Termux listens on the device's local interface.
Reaching the server from a PC browser requires the phone's LAN IP and
may need `listen: 0.0.0.0` in the ST configuration. Android cleartext
traffic and local firewall behaviour are outside this plugin's control
but should be documented in deployment guides (Phase 6, §25).

## 24. Testing Strategy

### 24.1 Pure event tests

- canonical serialization and hash fixtures;
- filename/envelope matching;
- ancestry and head calculation;
- deterministic selection independent of ingestion order;
- concurrent conflict and merge;
- late parent arrival;
- tombstone behavior;
- schema-version rejection.

### 24.2 Filesystem tests

- atomic publication and idempotent collision;
- partial/changing file intake;
- Syncthing temp/conflict names ignored;
- Windows/POSIX path fixtures;
- symlink/traversal rejection;
- local root physically separate from sync root;
- projection deletion and rebuild.

### 24.3 Two-replica simulation

Use two local roots, two replica IDs, and one replicated-directory simulator:

- independent creations;
- edits to different entities;
- concurrent edits to one entity;
- out-of-order and duplicate delivery;
- long offline interval;
- tombstone before parent;
- convergence to identical projections;
- duplicate replica-ID mutation block;
- no execution of another replica's generation.

Deterministic tests do not require real Syncthing. Release validation adds an optional real Syncthing integration test.

### 24.4 Blob tests

- upload deduplication;
- MIME/magic mismatch;
- oversized/high-pixel image;
- interrupted publication;
- corrupt hash-path file;
- missing blob projection;
- generated-result promotion order.

### 24.5 Credential tests

- synchronized connection appears keyless on fresh replica;
- entering key changes only local credential binding;
- key rotation does not rewrite connection event;
- secrets absent from sync files, API history, archive, logs, and errors.

### 24.6 Migration tests

- every legacy category and idempotent rerun;
- crash after every write/read-back/cleanup boundary;
- duplicate migration from two browsers;
- gallery data URL conversion;
- SillyTavern image path ingestion;
- missing image warning;
- no local deletion before verification;
- exact chat-binding ID preservation.

### 24.7 Paid-request tests

- only owner replica dispatches;
- synchronized `owned` job never triggers generation elsewhere;
- socket interruption recovers from owner journal;
- completed gallery/blob converges;
- ambiguous owner loss never resubmits;
- explicit new generation uses a new request ID.

### 24.8 Termux-specific tests

- **Private ext4**: atomic publish survives; fsync durability confirmed;
  mode-bit enforcement (`0600` files, `0700` dirs) holds; inotify watcher
  receives events; local-state rejection when on shared storage.
- **Shared FUSE degraded**: capability check reports `FS_FUSE_DEGRADED`;
  `link()` unavailable, `renameat2(RENAME_NOREPLACE)` fallback tested
  or `STORE_ATOMIC_PUBLISH_UNAVAILABLE` lock confirmed; mutex-protected
  publication correct without rename-overwrite; intake handles partial
  and stale writes; mode bits not relied upon.
- **PPK kill simulation**: SIGKILL during publication, blob promotion, and
  generation dispatch; intake recovers without data loss; `owned` jobs
  surface correctly on restart; incarnation expiry advances;
  `lastIncarnationKilledAt` reported in status.
- **Native module install**: `npm install` succeeds on a clean Termux
  environment without compilation failures; pure-JS fallback paths are
  exercised; header-first image validation works with pure-JS parsers.

## 25. Delivery Phases

### Phase 1: Storage foundation

- local root and replica identity;
- immutable event writer/reader;
- materializer and conflict model;
- blob ingestion/read API;
- store status/entity API;
- two-replica test harness.

No domain data moves yet.

### Phase 2: Low-risk entities

- templates;
- parameter presets;
- characters;
- folders;
- synchronized preferences;
- browser facade and migration.

### Phase 3: Connections and references

- connection metadata events;
- local credential bindings;
- reference metadata and blobs;
- adaptation of server image connection storage;
- conflict blocking for generation-critical entities.

### Phase 4: Drafts, histories, and gallery

- prompt history;
- generation drafts;
- gallery entities and blobs;
- migration of local gallery/data URLs/ST image paths;
- verified localforage cleanup.

### Phase 5: Generation publication

- replica-owned journals;
- synchronized safe job status;
- result promotion to blob plus gallery event;
- cross-replica completed-result visibility;
- interrupted-result tests.

### Phase 6: Backup and operations

- server archive/restore;
- conflict resolution UI;
- storage diagnostics;
- repair/quarantine tools;
- optional Syncthing integration suite;
- deployment and recovery documentation.

## 26. Acceptance Criteria

1. Chrome and Firefox connected to one SillyTavern user see the same durable data without export/import.
2. Windows and Termux replicas synchronizing `sync-v1` converge despite different absolute paths.
3. Independent writes to different entities merge without mutable-file conflicts.
4. Concurrent writes to one entity preserve both revisions and expose a resolvable conflict.
5. Reference and gallery images render on another replica after synchronization.
6. Deleting all local materialized indexes does not lose synchronized data.
7. Active paid requests are not executed or resumed by another replica.
8. Completed provider results become synchronized blob/gallery entities.
9. API keys never appear in synchronized events, blobs, archives, logs, or diagnostics.
10. A synchronized keyless connection cannot generate until a key is entered locally.
11. Existing localforage data is removed category-by-category only after verification.
12. Routine use no longer needs browser JSON export/import.
13. Deterministic suites pass on Windows and Linux; Termux and real replication smoke tests pass before release.

## 27. Consequences

This architecture accepts more small files and delayed convergence in exchange for:

- no browser-specific durable database;
- no synchronized mutable database;
- deterministic cross-platform merging;
- preservation of concurrent edits;
- content-addressed image portability;
- strict separation between user data and paid-operation authority.

It does not turn two SillyTavern processes into one distributed transactional server. It defines which state can safely converge through files and keeps exclusive operations bound to one replica.
