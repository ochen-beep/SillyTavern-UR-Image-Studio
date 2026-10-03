// @ts-check
/**
 * Sharded sibling of `file-store`: the same public contract (ready / mode /
 * snapshot / mutate / replace / persist / flush / flushOnUnload / footprint),
 * but the record collection lives in fixed-size shard files behind a tiny
 * manifest, so a mutation uploads only the shards its records actually touched
 * — a cost bounded by SHARD_TARGET records no matter how large the collection
 * grows. Files (`data/<user>/user/files/<name>`):
 *
 *   <manifestName>            { v, kind:'manifest', store, shards: [{id,count,min,max}] }
 *   <shardPrefix>sNNNN.json   { v, kind:'shard', store, id, records: [...] }
 *
 * Shard rows are ordered by id ASC = logical collection order (oldest first).
 * A gallery shard (`append: 'front'`, mirror is newest-first) stores its
 * records newest-first; refs shards (`append: 'back'`) keep insertion order.
 * A record never moves between shards after placement — new records go to the
 * newest shard, opening the next one at target size. Records arriving out of
 * range (via merge from another device) are placed by `placeStamp` into the
 * shard holding their stamp, overflowing it rather than splitting.
 *
 * The mirror handed to mutators is byte-compatible with `createFileStore`:
 * the full logical value. Writes diff the mirror against per-shard state by
 * record id and mark dirty shards; the serialized write loop re-reads each
 * dirty shard, three-way merges it (the shared `mergeServerValue`), and
 * uploads it — the same concurrent-writer safety as `mergeWithServer`, at
 * shard size. Manifest rows are derived data, merged with
 * the server copy the same way; a foreign shard unknown to this session is
 * adopted, never clobbered.
 *
 * Modes follow file-store: 'unknown' → 'file' | 'readonly'. Extra refusal
 * reason: 'shard-unreadable' — the manifest names a shard the server cannot
 * deliver (404/corrupt/newer ONLY; a thrown read is transient and retries via
 * ready()): the merge base is incomplete, so writes are refused for the
 * session instead of silently clobbering the missing part.
 * A corrupt manifest does not refuse: the shard sequence is gapless by
 * construction, so the manifest is rebuilt by probing shard GETs until the
 * first 404 and re-written (a store with no readable shards starts empty).
 */

import { log, warn } from './core.js';
import { recordDiagnosticEvent } from './diagnostic-events.js';
import {
    KEEPALIVE_BODY_LIMIT, textToBase64, stHeaders, mergeServerValue,
    parseVersionedDoc, registerFileStoreForDiagnostics, createFileStore,
} from './file-store.js';

const UPLOAD_URL = '/api/files/upload';
const FAILURE_TOAST_INTERVAL = 5000;
const PROBE_RETRY_MS = 10 * 1000;

function clone(value) {
    if (value === null || value === undefined) return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

/** Plain-data equality for diffing mirror records against the pre-mutate snapshot. */
function sameRecord(a, b) {
    if (a === b) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function defaultCountEntries(value) {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === 'object') return Object.keys(value).length;
    return null;
}

// ── HTTP ──

async function readFile(name) {
    const res = await fetch(`/user/files/${encodeURIComponent(name)}`, { method: 'GET', cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`read failed: ${res.status}`);
    const text = await res.text();
    return text || null;
}

/** Full-file atomic upload of one document; returns its JSON length in bytes. */
async function uploadDoc(name, doc) {
    const json = JSON.stringify(doc);
    const res = await fetch(UPLOAD_URL, {
        method: 'POST',
        headers: stHeaders(),
        body: JSON.stringify({ name, data: textToBase64(json) }),
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text().catch(() => '')}`);
    return json.length;
}

// ── Document shapes ──

function shardDoc(storeName, version, id, records) {
    return { v: version, kind: 'shard', store: storeName, id, records };
}

function manifestDoc(storeName, version, shards) {
    return { v: version, kind: 'manifest', store: storeName, shards };
}

function tombstoneDoc(storeName, version) {
    return { v: version, kind: 'migrated', store: storeName };
}

function parseShard(text, version) {
    const parsed = parseVersionedDoc(text, { version });
    if (parsed.reason === 'corrupt') return parsed;
    const doc = parsed.value;
    if (!doc || doc.kind !== 'shard' || !Array.isArray(doc.records)) return { reason: 'corrupt' };
    return { reason: parsed.reason, value: doc.records };
}

function parseManifest(text, version) {
    const parsed = parseVersionedDoc(text, { version });
    if (parsed.reason === 'corrupt') return parsed;
    const doc = parsed.value;
    if (!doc || doc.kind !== 'manifest' || !Array.isArray(doc.shards)) return { reason: 'corrupt' };
    return { reason: parsed.reason, value: doc };
}

/** Monolith parse for migration: `kind:'migrated'` means "already moved". */
function parseMonolith(text, version, key) {
    const parsed = parseVersionedDoc(text, { version });
    if (parsed.reason === 'corrupt') return parsed;
    // A tombstone — even a newer-versioned one — means "nothing to migrate": the shards/manifest of that newer build refuse at their own parse.
    if (parsed.value?.kind === 'migrated') return { reason: 'migrated' };
    const records = parsed.value?.[key];
    // The value differs by store: the gallery rides `key` as a bare array, refs
    // as a `{ refs, folders }` object — the sharded collection then rides
    // `shardedKey` inside it. Anything else is not this store's monolith.
    if (!Array.isArray(records) && (records === null || typeof records !== 'object')) return { reason: 'corrupt' };
    return { reason: parsed.reason, value: records };
}

// ── Store factory ── (the public contract is complete: ready / mode /
// snapshot / mutate / replace / persist / flush / flushOnUnload / footprint)

export function createShardedFileStore(config) {
    const {
        label,
        manifestName,
        shardPrefix,
        version = 1,
        monolithName = null,
        monolithKey = 'data',
        shardTarget = 250,
        append = 'front',
        placeByStamp = false,
        placeStamp = r => (Number.isFinite(r?.createdAt) ? r.createdAt : 0),
        empty = () => [],
        shardedKey = null,            // null: the mirror IS the record array (gallery); a string: the array rides mirror[key] (refs)
        countEntries = defaultCountEntries,
        mergeWithServer = true,
        keepaliveLimit = KEEPALIVE_BODY_LIMIT,
        onWriteFailure = null,
        meta = null,
    } = config;

    const shardFileName = id => `${shardPrefix}${id}.json`;

    // Small satellite arrays (refs folders) that must not ride the manifest:
    // the manifest has to be rebuildable from a shard scan alone, so anything
    // not derivable from the shards lives in its own plain file-store.
    const metaStore = meta ? createFileStore({
        label: `${label}-meta`,
        name: meta.name,
        version,
        key: 'data',
        empty: meta.empty || (() => ({})),
        mergeWithServer: true,
        onWriteFailure,
    }) : null;

    let mode = 'unknown';
    let readyPromise = null;
    let mirror = null;             // logical value; same shape as a file-store mirror
    let shards = [];               // manifest rows [{id, count, min, max}], id ASC
    let shardState = new Map();    // id → { records: [...], base: [...] | null }
    let recordShard = new Map();   // record id → shard id (placement, frozen)
    let dirtyShards = new Set();
    let emptyShards = new Set();   // shards to overwrite as `records: []` and drop
    let manifestDirty = false;
    // Our manifest rows as of the last landed manifest write (or the load) —
    // the three-way merge base for `writeManifest`, the rows' analogue of
    // `state.base`. `shards` itself is already post-mutation by the time the
    // write loop runs, so it cannot serve as the base: every server row would
    // look like a remote edit and each write would revert to it.
    let manifestBaseRows = [];
    let suppressMergeOnce = false; // migration / replace clobber the server, no merge
    let writeJob = null;
    let lastWriteOk = true;
    let lastFailureToastAt = 0;
    let totalBytes = null;
    let lastError = null;
    // Session-level persist refusal — WHY the mode is readonly
    // ('no-user-files' | 'newer-version' | 'shard-unreadable' — a corrupt
    // manifest no longer blocks: it is rebuilt from a shard scan).
    // schedulePersist reports this cause instead of guessing.
    let writeBlockedReason = null;
    const refusedNotified = new Set();

    function emit(event, fields = {}) {
        try {
            recordDiagnosticEvent({
                event,
                stage: 'storage',
                level: fields.level,
                outcome: fields.result || null,
                durationMs: fields.ms,
                details: { store: label, ...fields },
            });
        } catch { /* diagnostics must never break storage */ }
    }

    function notifyFailure(cause) {
        warn(`sharded-store[${label}]:`, cause?.message || cause);
        const now = Date.now();
        if (now - lastFailureToastAt < FAILURE_TOAST_INTERVAL) return;
        lastFailureToastAt = now;
        try {
            if (onWriteFailure) onWriteFailure(cause);
            else globalThis.toastr?.error?.(`Не удалось сохранить «${label}» на сервер.`);
        } catch { /* no toastr in tests */ }
    }

    function refusePersist(reason) {
        lastWriteOk = false;
        lastError = reason;
        if (refusedNotified.has(reason)) return;
        refusedNotified.add(reason);
        emit('store-write-skipped', { store: label, reason, level: 'warn' });
        warn(`sharded-store[${label}]: writes refused (${reason})`);
        try {
            const messages = {
                'newer-version': `«${label}»: данные записаны более новой версией расширения — обновите UR Image Studio; запись отключена.`,
                'no-user-files': `«${label}»: SillyTavern не поддерживает файловое хранилище (обновите SillyTavern); запись отключена.`,
                'shard-unreadable': `«${label}»: не удалось прочитать часть данных при запуске — запись заблокирована, чтобы не потерять остальное. Перезагрузите страницу.`,
            };
            const message = messages[reason] || `«${label}»: запись отключена (${reason}).`;
            if (onWriteFailure) onWriteFailure(new Error(reason));
            else globalThis.toastr?.error?.(message);
        } catch { /* no toastr in tests */ }
    }

    // ── Placement state helpers ──

    function rowFor(id) { return shards.find(row => row.id === id); }

    function recomputeRow(id) {
        const state = shardState.get(id);
        const row = rowFor(id);
        let min = null, max = null;
        for (const record of state.records) {
            const stamp = placeStamp(record);
            if (min === null || stamp < min) min = stamp;
            if (max === null || stamp > max) max = stamp;
        }
        row.count = state.records.length;
        row.min = min;
        row.max = max;
    }

    function nextShardId() {
        const last = shards.length ? shards[shards.length - 1].id : null;
        const n = last ? parseInt(last.slice(1), 10) + 1 : 0;
        return 's' + String(n).padStart(4, '0');
    }

    /** Register a shard's records as the local state for `id` (no dirt). */
    function adoptShard(id, records) {
        shardState.set(id, { records, base: clone(records) });
        for (const record of records) recordShard.set(String(record.id), id);
        shards.push({ id, count: records.length, min: null, max: null });
        recomputeRow(id);
    }

    /** The logical collection in mirror order, per `shardedKey`. */
    function recordList() {
        if (shardedKey) return Array.isArray(mirror?.[shardedKey]) ? mirror[shardedKey] : [];
        return Array.isArray(mirror) ? mirror : [];
    }

    /**
     * Rebuild the mirror from shard state. Rows are kept sorted by id ASC
     * (oldest first). Gallery shards store newest-first, so the newest-first
     * mirror (`append: 'front'`) concatenates shards in REVERSE id order; refs
     * shards keep insertion order (`append: 'back'`) and concatenate ASC.
     */
    function rebuildMirrorFromShards() {
        shards.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const ordered = append === 'front' ? [...shards].reverse() : shards;
        const list = ordered.flatMap(row => shardState.get(row.id).records);
        if (shardedKey) { mirror[shardedKey] = list; return; }
        mirror = list;
    }

    // ── Meta satellite ──

    /** Hydrate the mirror's satellite keys from the meta store. */
    async function hydrateMeta() {
        if (!metaStore || !meta?.keys?.length) return;
        await metaStore.ready();
        const satellite = metaStore.snapshot() || meta.empty();
        for (const key of meta.keys) mirror[key] = clone(satellite[key]);
    }

    /** Push the mirror's satellite keys into the meta store when they differ. */
    async function syncMeta(force = false) {
        if (!metaStore || !meta?.keys?.length) return;
        const satellite = {};
        for (const key of meta.keys) satellite[key] = clone(mirror[key]);
        const current = metaStore.snapshot();
        if (!force && JSON.stringify(current) === JSON.stringify(satellite)) return;
        await metaStore.mutate(m => {
            for (const k of Object.keys(m)) delete m[k];
            Object.assign(m, satellite);
        });
        await metaStore.flush();
    }

    // ── Load ──

    /**
     * Load every shard the manifest names, in parallel. A genuinely undeliverable
     * shard (404/corrupt/newer) makes the whole store readonly: the merge base
     * would be incomplete and a write could silently clobber the missing part.
     * A THROWN read (5xx / surface unreachable) is transient, not absence —
     * it returns null so the caller's detectAndLoadOnce restarts the whole
     * load via ready() instead of bricking the session readonly.
     * @returns {Promise<boolean|null>} true loaded, false readonly, null retry
     */
    async function loadShards(rows) {
        const results = await Promise.all(rows.map(async row => {
            try {
                const text = await readFile(shardFileName(row.id));
                if (text === null) return { id: row.id, reason: 'missing' };
                const parsed = parseShard(text, version);
                if (parsed.reason === 'found' || parsed.reason === 'older') {
                    return { id: row.id, reason: 'ok', records: parsed.value };
                }
                return { id: row.id, reason: parsed.reason };
            } catch {
                return { id: row.id, reason: 'transient' };
            }
        }));
        const bad = results.find(result => result.reason !== 'ok');
        if (bad) {
            if (bad.reason === 'transient') return null;   // not proof of absence — retry via ready()
            mode = 'readonly';
            writeBlockedReason = 'shard-unreadable';
            emit('store-mode', { store: label, result: 'readonly', reason: 'shard-unreadable', shard: bad.id });
            log(`sharded-store[${label}]: mode=readonly (shard ${bad.id} ${bad.reason})`);
            refusePersist('shard-unreadable');
            return false;
        }
        for (const result of results) adoptShard(result.id, result.records);
        return true;
    }

    /**
     * The manifest is corrupt or lost, but shard files may exist. Shard ids
     * are gapless s0000…sNNNN by construction, so the sequence is recoverable
     * by probing GETs until the first 404 (user-files has no directory
     * listing). Every readable shard is adopted; the rebuilt manifest is
     * written immediately so the next session does not re-probe. The probe
     * loop catches its own read throws per file (a transient shard read just
     * ends the scan); a throw OUT of this function means the recovery WRITE
     * (the manifest upload) failed — the caller returns `null` so ready()
     * retries the whole load from scratch, which is idempotent: this
     * function resets the placement state before re-probing.
     *
     * Known limit of the gapless probe: a shrinking `replace()` can leave
     * surplus old shard files on the server; if the manifest is later
     * corrupted, those stale files are re-adopted — records resurrect rather
     * than vanish, which is the acceptable direction. A future change may
     * overwrite surplus files during the recovery; until then this stays a
     * recovery-path-only limit.
     */
    async function rebuildFromScan() {
        shards = [];
        shardState = new Map();
        recordShard = new Map();
        for (let n = 0; n < 10_000; n++) {
            const id = 's' + String(n).padStart(4, '0');
            let text;
            try { text = await readFile(shardFileName(id)); } catch { break; }
            if (text === null) break;
            const parsed = parseShard(text, version);
            if (parsed.reason !== 'found' && parsed.reason !== 'older') break;
            adoptShard(id, parsed.value);
        }
        rebuildMirrorFromShards();
        if (!shards.length) {
            warn(`sharded-store[${label}]: corrupt manifest and no readable shards — starting empty`);
            return;
        }
        manifestDirty = true;
        await writeManifest([]);
        emit('store-recovered', { store: label, result: 'ok', shards: shards.length, entries: countEntries(mirror) });
        log(`sharded-store[${label}]: manifest rebuilt from ${shards.length} shard(s)`);
    }

    async function detectAndLoadOnce() {
        const started = Date.now();
        let probe;
        try {
            probe = await fetch('/api/files/verify', { method: 'POST', headers: stHeaders(), body: JSON.stringify({ urls: [] }) });
        } catch {
            return null;   // surface unreachable — ready() keeps retrying
        }
        if (!probe.ok) {
            mode = 'readonly';
            writeBlockedReason = 'no-user-files';
            mirror = empty();
            emit('store-mode', { store: label, result: 'readonly', reason: 'no-user-files' });
            refusePersist('no-user-files');
            return mode;
        }
        mode = 'file';

        let text = null;
        try { text = await readFile(manifestName); } catch { text = undefined; }
        if (text === undefined) return null;   // non-404 read failure — retry via ready()

        if (text === null) {
            if (!monolithName) {
                mirror = empty();
                emit('store-mode', { store: label, result: 'file', reason: 'missing' });
                emit('store-load', { store: label, result: 'missing', entries: countEntries(mirror), bytes: 0, ms: Date.now() - started });
                return mode;
            }
            // Initialize the mirror BEFORE migrating: rebuildMirrorFromShards()
            // writes through `mirror[shardedKey]`, which would throw on a null
            // mirror (and memoize a rejected readyPromise). empty() keeps the
            // store's shape — a refs store keeps its folders.
            mirror = empty();
            const verdict = await attemptMigration();
            if (verdict === 'unresolved') return null;   // monolith unreadable right now — retry
            if (verdict === 'refused') return mode;
            if (verdict === 'fresh') {
                mirror = empty();
                emit('store-mode', { store: label, result: 'file', reason: 'missing' });
                emit('store-load', { store: label, result: 'missing', entries: countEntries(mirror), bytes: 0, ms: Date.now() - started });
            }
            // 'migrated': the mirror is built from the shards — the satellite
            // keys (refs folders) still come from the meta store.
            if (metaStore) await hydrateMeta();
            return mode;
        }

        const parsed = parseManifest(text, version);
        if (parsed.reason === 'newer') {
            mode = 'readonly';
            writeBlockedReason = 'newer-version';
            emit('store-mode', { store: label, result: 'readonly', reason: 'newer-version' });
            refusePersist('newer-version');
            return mode;
        }
        if (parsed.reason === 'corrupt') {
            // The scan is safe: it only reads shard files and writes a derived
            // manifest. With NO readable shards the store legitimately starts
            // empty — file-store's corrupt→repair semantics for a document
            // whose data is already gone.
            mirror = empty();
            mode = 'file';
            writeBlockedReason = null;
            // A transient failure in the recovery WRITE (the only unwrapped
            // throwing calls left inside rebuildFromScan) must not memoize a
            // rejected readyPromise — that would brick every ready()/mutate()
            // caller for the session. Return null instead: ready() re-probes,
            // the (still corrupt) manifest is re-read and the scan re-runs —
            // idempotent, the scan resets its own placement state first.
            try {
                await rebuildFromScan();
            } catch {
                return null;   // recovery write failed transiently — retry via ready()
            }
            emit('store-mode', { store: label, result: 'file', reason: 'corrupt-manifest' });
            return mode;
        }

        mirror = empty();
        const ok = await loadShards(parsed.value.shards || []);
        if (ok === null) return null;   // transient shard read — the load retries via ready()
        if (!ok) return mode;
        manifestBaseRows = (parsed.value.shards || []).map(row => ({ ...row }));
        rebuildMirrorFromShards();
        if (metaStore) await hydrateMeta();
        totalBytes = text.length;
        emit('store-mode', { store: label, result: 'file', reason: parsed.reason });
        emit('store-load', {
            store: label, result: parsed.reason, entries: countEntries(mirror),
            bytes: totalBytes, ms: Date.now() - started,
        });
        log(`sharded-store[${label}]: mode=file, ${shards.length} shard(s), ${countEntries(mirror)} entr(ies)`);
        return mode;
    }

    /**
     * Resolve the store mode once per session. While the user-files surface is
     * unreachable the promise stays pending and the probe repeats after the
     * retry window: there is nothing honest to resolve with, and callers'
     * `await ready()` simply waits for storage to answer.
     */
    function ready() {
        if (!readyPromise) {
            readyPromise = (async () => {
                for (;;) {
                    const result = await detectAndLoadOnce();
                    if (result !== null) return result;
                    await new Promise(resolve => setTimeout(resolve, PROBE_RETRY_MS));
                }
            })();
        }
        return readyPromise;
    }

    // ── Mutation diff ──

    /** Chunk helper: the logical list oldest-first, regardless of append side. */
    function oldestFirst(list) {
        return append === 'front' ? [...list].reverse() : list;
    }

    /**
     * Place one new record. In-range adds go to the newest shard (opening the
     * next one at target size). A record older than the newest shard's range
     * (arrived via merge/import) is placed by `placeStamp` into the shard that
     * holds its stamp — overflowing it rather than splitting, so placement
     * stays deterministic across devices without B-tree machinery.
     * @returns {boolean} true when the record landed OUT of the newest shard
     *          (the mirror then needs a canonical-order rebuild)
     */
    function placeRecord(record) {
        const stamp = placeStamp(record);
        if (placeByStamp && shards.length && stamp < shards[shards.length - 1].min) {
            let target = shards[0];   // older than everything → the oldest shard
            for (const row of shards) {
                if (stamp <= row.max) { target = row; break; }
            }
            const state = shardState.get(target.id);
            let idx = state.records.length;   // default: the oldest edge
            if (append === 'front') {
                idx = state.records.findIndex(r => placeStamp(r) < stamp);
                if (idx === -1) idx = state.records.length;
            } else {
                idx = state.records.findIndex(r => placeStamp(r) > stamp);
                if (idx === -1) idx = state.records.length;
            }
            state.records.splice(idx, 0, record);
            recordShard.set(String(record.id), target.id);
            recomputeRow(target.id);
            dirtyShards.add(target.id);
            return true;
        }
        if (!shards.length || shards[shards.length - 1].count >= shardTarget) {
            adoptShard(nextShardId(), []);
            manifestDirty = true;
        }
        const row = shards[shards.length - 1];
        const state = shardState.get(row.id);
        if (append === 'front') state.records.unshift(record);
        else state.records.push(record);
        recordShard.set(String(record.id), row.id);
        recomputeRow(row.id);
        dirtyShards.add(row.id);
        return false;
    }

    /**
     * Diff the mirror against the pre-mutate snapshot. New records are placed
     * (frozen assignment), updated records mark their shard, removed records
     * shrink theirs. Existing records never move between shards. Any real
     * change dirties the manifest too — rows are cheap and derived.
     */
    function syncFromMirror(before) {
        const list = recordList();
        const seen = new Set();
        let changed = false;
        let outOfRange = false;
        for (const record of list) {
            const id = String(record.id);
            seen.add(id);
            const sid = recordShard.get(id);
            if (sid === undefined) {
                if (placeRecord(record)) outOfRange = true;
                changed = true;
                continue;
            }
            if (!sameRecord(before.get(id), record)) {
                const state = shardState.get(sid);
                const idx = state.records.findIndex(r => String(r.id) === id);
                if (idx !== -1) state.records[idx] = record;
                recomputeRow(sid);
                dirtyShards.add(sid);
                changed = true;
            }
        }
        for (const [id, sid] of recordShard) {
            if (seen.has(id)) continue;
            recordShard.delete(id);
            const state = shardState.get(sid);
            const idx = state.records.findIndex(r => String(r.id) === id);
            if (idx !== -1) state.records.splice(idx, 1);
            recomputeRow(sid);
            if (shardState.get(sid).records.length === 0 && shards.length > 1) emptyShards.add(sid);
            dirtyShards.add(sid);
            changed = true;
        }
        // After the removals too: the rebuild must see the settled shard state,
        // or a record deleted by the same mutation would stay in the mirror.
        if (outOfRange) rebuildMirrorFromShards();   // canonical newest-first order
        if (changed) manifestDirty = true;
        return changed;
    }

    // ── Persist: serialized loop — dirty shards first (merge per shard), manifest last ──

    function schedulePersist() {
        if (mirror === null) return Promise.resolve(false);
        if (mode === 'readonly') { refusePersist(writeBlockedReason || 'newer-version'); return Promise.resolve(false); }
        if (mode !== 'file') return Promise.resolve(false);
        if (!writeJob) writeJob = runWriteLoop();
        return writeJob;
    }

    /**
     * Merge the server copy of one shard into the local records. Returns the
     * records to upload (local when there is nothing to blend). A `newer`
     * shard refuses the write for the session.
     */
    async function mergeShardWithServer(id, local) {
        if (!mergeWithServer || suppressMergeOnce) return { records: local };
        const text = await readFile(shardFileName(id));
        if (text === null) return { records: local };   // 404: nothing on server
        const parsed = parseShard(text, version);
        if (parsed.reason === 'newer') { refusePersist('newer-version'); return { records: null, refused: true }; }
        if (parsed.reason !== 'found' && parsed.reason !== 'older') return { records: local };
        const state = shardState.get(id);
        const merged = mergeServerValue(state.base || [], parsed.value, local);
        if (merged === null) return { records: local };
        return { records: merged };
    }

    /**
     * Splice merged records back: the shard state becomes the merged array,
     * `append: 'front'` shards are re-sorted newest-first (merge appends
     * foreign additions at the end; the stamp order is the shard contract),
     * and the mirror is rebuilt so reads see the true state.
     */
    function applyMergedRecords(id, records) {
        const state = shardState.get(id);
        if (append === 'front') {
            records.sort((a, b) => placeStamp(b) - placeStamp(a));
        }
        // Merged-in foreign records must join the placement registry, or the
        // next sync would see them as unplaced and re-place them as new —
        // duplicating them across (or within) shards, persistent on reload.
        for (const record of records) {
            const key = String(record.id);
            if (!recordShard.has(key)) recordShard.set(key, id);
        }
        state.records = records;
        recomputeRow(id);
        rebuildMirrorFromShards();
    }

    /**
     * Load a shard this session has never seen (another tab made it).
     * @returns {Promise<'adopted'|'missing'|'error'>}
     *   'adopted' — records fetched and registered;
     *   'missing' — 404, or an empty file (nothing to adopt, an emptied
     *   shard): the row may be dropped from the manifest;
     *   'error'   — unreachable / corrupt / newer build: NOT proof of
     *   absence, the row must not be silently dropped.
     */
    async function adoptForeignShard(row) {
        let text;
        try {
            text = await readFile(shardFileName(row.id));
        } catch {
            return 'error';   // transient read failure — the shard may be healthy
        }
        if (text === null) return 'missing';
        const parsed = parseShard(text, version);
        if (parsed.reason !== 'found' && parsed.reason !== 'older') return 'error';
        if (!parsed.value.length) return 'missing';
        adoptShard(row.id, parsed.value);
        return 'adopted';
    }

    /**
     * Upload one dirty shard with a pre-write merge. The merged content (if
     * any) becomes the mirror's version of those records before the upload.
     */
    async function writeShard(id) {
        const started = Date.now();
        const state = shardState.get(id);
        const { records, refused } = await mergeShardWithServer(id, state.records);
        if (refused) return false;
        if (records !== state.records) applyMergedRecords(id, records);
        const bytes = await uploadDoc(shardFileName(id), shardDoc(label, version, id, records));
        state.base = clone(records);
        totalBytes = bytes;
        emit('store-write', { store: label, result: 'success', shard: id, entries: records.length, bytes, ms: Date.now() - started });
        return true;
    }

    /**
     * Upload the manifest. Foreign shard rows unknown to this session are
     * adopted first (their records fetched and merged into the mirror), then
     * the row set is three-way merged (base = our rows as of the last landed
     * manifest write). KNOWN LIMITATION, shared with the sibling store's
     * whole-document merge: a row another tab deleted while we never touched
     * its shard can be resurrected by our write — without tombstones the
     * merge cannot tell a foreign deletion from a stale read. An adoption
     * that fails for any reason other than 404 aborts the write (the row
     * stays queued); rows without local shard state are skipped, never
     * invented.
     */
    async function writeManifest(manifestBase) {
        const started = Date.now();
        let serverRows = null;
        if (mergeWithServer && !suppressMergeOnce) {
            const text = await readFile(manifestName);
            if (text !== null) {
                const parsed = parseManifest(text, version);
                if (parsed.reason === 'newer') {
                    refusePersist('newer-version');
                    manifestDirty = true;   // refusals do not consume the queued work
                    return false;
                }
                if (parsed.reason === 'found' || parsed.reason === 'older') serverRows = parsed.value.shards;
                // corrupt → our rows are the only source: the write rebuilds
            }
        }
        if (serverRows) {
            for (const row of serverRows) {
                if (rowFor(row.id)) continue;
                if (await adoptForeignShard(row) === 'error') {
                    // Not proof of absence (5xx / corrupt / newer build):
                    // dropping the row would orphan live foreign data, a
                    // newer build's row would be clobbered. Abort the write —
                    // the next settle re-reads the manifest and retries.
                    // Per-settle at most one abort, so no dedupe is needed.
                    emit('store-write-skipped', { store: label, reason: 'adopt-error', shard: row.id, level: 'warn' });
                    manifestDirty = true;
                    lastWriteOk = false;   // flush() must report the unfinished write
                    return false;
                }
            }
            if (shards.some(row => !manifestBase.some(baseRow => baseRow.id === row.id))) {
                rebuildMirrorFromShards();   // adopted records must reach the mirror
            }
        }
        const ourRows = shards.map(row => ({ ...row }));
        let rows = ourRows;
        if (serverRows) {
            const merged = mergeServerValue(manifestBase, serverRows, ourRows);
            if (merged) rows = merged.filter(row => shardState.has(row.id) || emptyShards.has(row.id));
        }
        shards = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const bytes = await uploadDoc(manifestName, manifestDoc(label, version, shards.map(row => ({ ...row }))));
        manifestBaseRows = shards.map(row => ({ ...row }));
        totalBytes = bytes;
        emit('store-write', { store: label, result: 'success', shard: 'manifest', entries: shards.length, bytes, ms: Date.now() - started });
        return true;
    }

    async function runWriteLoop() {
        let ok = true;
        let failed = null;
        const manifestBase = manifestBaseRows.map(row => ({ ...row }));
        try {
            while (true) {
                const id = dirtyShards.values().next().value;
                if (id === undefined) break;
                dirtyShards.delete(id);
                if (emptyShards.has(id)) {
                    // The shard lost every record: overwrite it empty (no
                    // DELETE route) and drop it from the manifest.
                    emptyShards.delete(id);
                    const started = Date.now();
                    try {
                        const bytes = await uploadDoc(shardFileName(id), shardDoc(label, version, id, []));
                        emit('store-write', { store: label, result: 'success', shard: id, entries: 0, bytes, ms: Date.now() - started });
                    } catch (cause) {
                        dirtyShards.add(id);
                        emptyShards.add(id);
                        failed = { cause, shard: id };
                        break;
                    }
                    // A mutation coalesced while the empty overwrite was in
                    // flight may have placed records into the dying shard.
                    // Re-validate before dropping, or recordShard would keep
                    // pointing at deleted state and every later settle would
                    // throw on it.
                    if ((shardState.get(id)?.records.length ?? 0) > 0) {
                        dirtyShards.add(id);   // stays alive; the merge-write below replaces the empty file
                        continue;
                    }
                    shardState.delete(id);
                    shards = shards.filter(row => row.id !== id);
                    for (const [rid, sid] of recordShard) if (sid === id) recordShard.delete(rid);
                    manifestDirty = true;
                    continue;
                }
                try {
                    if (!(await writeShard(id))) { ok = false; break; }
                } catch (cause) {
                    dirtyShards.add(id);   // stays pending: next mutation or flush retries
                    failed = { cause, shard: id };
                    break;
                }
            }
            // `failed` too: a shard upload that threw must not be followed by
            // a manifest naming that shard — the next load would find the row
            // and not the file, and go readonly ('shard-unreadable').
            if (ok && !failed && manifestDirty) {
                manifestDirty = false;
                try {
                    if (!(await writeManifest(manifestBase))) ok = false;
                } catch (cause) {
                    manifestDirty = true;
                    failed = { cause, shard: 'manifest' };
                }
            }
        } finally {
            writeJob = null;
            suppressMergeOnce = false;   // consumed: the next settle merges again
        }
        if (failed) {
            ok = false;
            lastWriteOk = false;
            lastError = String(failed.cause?.message || failed.cause);
            emit('store-write', { store: label, result: 'error', shard: failed.shard, level: 'error', reason: lastError });
            notifyFailure(failed.cause);
        } else if (ok) {
            lastWriteOk = true;
            lastError = null;
        }
        return ok;
    }

    // ── Migration ──

    /**
     * Manifest missing + monolith configured → migrate. Chunks the monolith by
     * position (its array already IS the logical order), writes the shards
     * WITHOUT merge (the monolith is the authority until the manifest commit;
     * two simultaneous migrations produce identical content and converge),
     * commits with the manifest, then tombstones the monolith. An interruption
     * before the manifest write repeats cleanly on the next ready().
     * @returns {Promise<'migrated'|'fresh'|'refused'|'unresolved'>}
     */
    async function attemptMigration() {
        let text;
        try { text = await readFile(monolithName); } catch { return 'unresolved'; }
        if (text === null) return 'fresh';
        const parsed = parseMonolith(text, version, monolithKey);
        if (parsed.reason === 'newer') {
            mode = 'readonly';
            writeBlockedReason = 'newer-version';
            emit('store-mode', { store: label, result: 'readonly', reason: 'newer-version' });
            refusePersist('newer-version');
            return 'refused';
        }
        const body = parsed.reason === 'found' || parsed.reason === 'older' ? parsed.value : null;
        if (body === null) {
            if (parsed.reason === 'corrupt') {
                // A corrupt monolith is not a tombstone: come up empty and
                // loud, leave the file untouched so a hand-fix can migrate
                // later (mirrors the monolith-shape guard below).
                emit('store-migrated', { store: label, result: 'error', reason: 'monolith-corrupt' });
                warn(`sharded-store[${label}]: monolith is corrupt — migration skipped`);
            }
            // Already migrated (tombstoned monolith): nothing to move, nothing
            // to write — the store simply comes up empty.
            mirror = empty();
            return 'migrated';
        }
        // Monolith values differ by store: the gallery is a bare array, refs is
        // `{ refs, folders }` — the sharded collection rides `shardedKey`. A
        // collection that is not an array gets the honest early-out, whichever
        // shape the store has: a hand-corrupted gallery `cards` (an object)
        // would crash `oldestFirst` and brick the session on a memoized
        // rejected ready(); a refs monolith whose `shardedKey` went misshapen
        // would migrate empty and tombstone, silently destroying the companion
        // data that lives alongside it (the refs folders). The mirror is
        // already `empty()` and the mode is 'file': come up empty and loud,
        // and leave the monolith untouched (no tombstone, no writes) so a
        // hand-fixed file can still migrate later.
        const records = shardedKey
            ? (Array.isArray(body[shardedKey]) ? body[shardedKey] : null)
            : body;
        if (!Array.isArray(records)) {
            emit('store-migrated', { store: label, result: 'error', reason: 'monolith-shape' });
            warn(`sharded-store[${label}]: monolith has an unexpected shape — migration skipped`);
            return 'migrated';
        }
        if (shardedKey && body && metaStore && meta?.keys?.length) {
            // Satellite arrays (refs folders) ride the meta store, never shards;
            // the legacy monolith is their only pre-migration home. Without this
            // hand-off a tombstoned monolith would destroy the companion data.
            // Runs before the shard commit: a retried migration re-writes the
            // same satellite (mergeWithServer makes the repeat idempotent).
            await metaStore.ready();
            const satellite = {};
            for (const key of meta.keys) {
                if (Array.isArray(body[key])) satellite[key] = clone(body[key]);
            }
            await metaStore.mutate(m => {
                for (const k of Object.keys(m)) delete m[k];
                Object.assign(m, satellite);
            });
            const flushed = await metaStore.flush();
            // A transient meta-upload failure must not commit the migration:
            // manifest + tombstone would strand folders that only lived in the
            // monolith. 'unresolved' sends ready() into the idempotent retry —
            // the monolith is untouched and this attempt has written no shards.
            // A readonly meta store (a newer build's meta file) stays as-is:
            // there the mutate no-ops and the newer document owns the data.
            if (!flushed && metaStore.mode() === 'file') return 'unresolved';
        }
        // A retried migration (an earlier attempt failed mid-write) starts
        // from a clean slate: re-adopting chunks onto the leftover placement
        // state would renumber them past the already-written shards and
        // duplicate every record on the server.
        shards = [];
        shardState = new Map();
        recordShard = new Map();
        dirtyShards = new Set();
        emptyShards = new Set();
        manifestBaseRows = [];
        manifestDirty = false;
        const ordered = oldestFirst(records);
        for (let i = 0; i < ordered.length; i += shardTarget) {
            const chunk = ordered.slice(i, i + shardTarget);
            if (append === 'front') chunk.reverse();   // shard-internal newest-first
            const id = nextShardId();
            adoptShard(id, chunk);
            dirtyShards.add(id);
        }
        rebuildMirrorFromShards();   // the mirror must reflect the migrated records
        manifestDirty = true;
        suppressMergeOnce = true;   // the monolith is the migration authority
        const outcome = await runWriteLoop();
        if (!outcome) return 'unresolved';
        try {
            await uploadDoc(monolithName, tombstoneDoc(label, version));
        } catch (cause) {
            // The migration has committed (the manifest exists), so a failed
            // tombstone is benign across restarts: the next ready() takes the
            // manifest path and never re-reads the monolith.
            emit('store-migrated', { store: label, result: 'error', reason: String(cause?.message || cause) });
            warn(`sharded-store[${label}]: tombstone upload failed:`, cause?.message || cause);
            return 'migrated';
        }
        emit('store-migrated', { store: label, result: 'ok', shards: shards.length, entries: records.length });
        log(`sharded-store[${label}]: migrated ${records.length} record(s) into ${shards.length} shard(s)`);
        return 'migrated';
    }

    const store = {
        label,
        name: manifestName,
        manifestName,
        shardPrefix,

        ready,
        mode: () => mode,
        isFileMode: () => mode === 'file',
        snapshot() { return mirror === null ? null : clone(mirror); },
        async mutate(mutator, { persist: shouldPersist = true } = {}) {
            await ready();
            if (mirror === null) mirror = empty();
            // The pre-mutate snapshot must be a COPY: mutators edit records in
            // place, so reference or same-object comparison would never see
            // their changes.
            const before = new Map(recordList().map(record => [String(record.id), clone(record)]));
            const result = mutator(mirror);
            const changed = syncFromMirror(before);
            // Satellite keys ride their own meta store, ahead of the shard
            // persist: a folders-only edit leaves the shard diff "unchanged",
            // yet the mirror change must still reach the meta file.
            if (metaStore) await syncMeta();
            // Awaited: when `mutate` resolves, its write has landed (callers
            // and tests read server state right after; the loop still coalesces
            // mutations issued while it is in flight).
            if (changed && shouldPersist) await schedulePersist();
            return result;
        },
        /**
         * Replace the whole value and await durability (backup restore). The
         * server is clobbered, not merged (suppressMergeOnce): shards are
         * re-chunked by position from the value.
         */
        async replace(value) {
            await ready();
            mirror = value === undefined ? empty() : value;
            shards = [];
            shardState = new Map();
            recordShard = new Map();
            dirtyShards = new Set();
            emptyShards = new Set();
            manifestBaseRows = [];
            const ordered = oldestFirst(recordList());
            for (let i = 0; i < ordered.length; i += shardTarget) {
                const chunk = ordered.slice(i, i + shardTarget).map(record => record);
                if (append === 'front') chunk.reverse();
                const id = nextShardId();
                adoptShard(id, chunk);
                dirtyShards.add(id);
            }
            manifestDirty = true;
            suppressMergeOnce = true;
            if (metaStore) await syncMeta(true);
            const job = schedulePersist();
            if (job) await job;
            return lastWriteOk;
        },
        persist() { return schedulePersist(); },
        /** Await quiescence: every mutation issued so far has reached the server. */
        async flush() {
            let guard = 0;
            while (writeJob && guard++ < 1000) await writeJob;
            if (metaStore) await metaStore.flush();
            return lastWriteOk;
        },

        /**
         * Last-chance durability on page unload: dirty shards whose payloads
         * fit the keepalive cap fly with `keepalive: true` (idempotent
         * full-file writes). Over-limit shards are skipped with one aggregated
         * event — the same honest behavior as file-store, at shard size. The
         * manifest is sent only when every dirty shard flew: a skipped shard
         * means the manifest stays behind on purpose — rebuildFromScan
         * recovers a missing manifest, nothing recovers a manifest naming a
         * missing shard. Dirty flags are NOT cleared: the write loop
         * re-sending identical content later is harmless.
         *
         * The meta satellite (refs folders) flushes here too: a folders-only
         * edit leaves no shard/manifest dirt, and without this a failed or
         * in-flight meta upload at pagehide would silently revert the rename
         * on reload (the pre-sharding monolith flush carried it). Same
         * fire-and-forget shape — file-store's own guard no-ops it when
         * nothing is pending.
         */
        flushOnUnload() {
            if (mode !== 'file') return;
            if (metaStore) metaStore.flushOnUnload();
            if (!dirtyShards.size && !manifestDirty) return;
            let sent = 0, skipped = 0, bytes = 0;
            for (const id of [...dirtyShards]) {
                const state = shardState.get(id);
                if (!state) continue;
                const json = JSON.stringify(shardDoc(label, version, id, state.records));
                if (json.length > keepaliveLimit) { skipped++; continue; }
                try {
                    void fetch(UPLOAD_URL, {
                        method: 'POST',
                        headers: stHeaders(),
                        body: JSON.stringify({ name: shardFileName(id), data: textToBase64(json) }),
                        keepalive: true,
                    });
                    sent++;
                    bytes += json.length;
                } catch { /* nothing else can be done during teardown */ }
            }
            // Suppressed when any shard was skipped: a manifest naming a file
            // the server cannot deliver would leave the next session
            // permanently readonly ('shard-unreadable') — a reload cannot fix
            // that; a MISSING manifest is the recoverable state.
            if (manifestDirty && !skipped) {
                const json = JSON.stringify(manifestDoc(label, version, shards.map(row => ({ ...row }))));
                if (json.length <= keepaliveLimit) {
                    try {
                        void fetch(UPLOAD_URL, {
                            method: 'POST',
                            headers: stHeaders(),
                            body: JSON.stringify({ name: manifestName, data: textToBase64(json) }),
                            keepalive: true,
                        });
                        sent++;
                        bytes += json.length;
                    } catch { /* teardown */ }
                } else skipped++;
            }
            if (sent || skipped) {
                emit('store-unload-flush', { store: label, result: sent ? 'sent' : 'skipped', shards: sent, skipped, bytes });
            }
        },
        footprint() {
            return {
                label,
                file: manifestName,
                mode,
                entries: mirror === null ? null : countEntries(mirror),
                bytes: totalBytes,
                lastWriteOk,
                lastError,
            };
        },
        diagnostics: () => ({ mode, shards: shards.length, entries: mirror === null ? null : countEntries(mirror) }),
        reset() {
            mode = 'unknown';
            readyPromise = null;
            mirror = null;
            shards = [];
            shardState = new Map();
            recordShard = new Map();
            dirtyShards = new Set();
            emptyShards = new Set();
            manifestDirty = false;
            manifestBaseRows = [];
            suppressMergeOnce = false;
            writeJob = null;
            lastWriteOk = true;
            lastFailureToastAt = 0;
            totalBytes = null;
            lastError = null;
            writeBlockedReason = null;
            refusedNotified.clear();
            if (metaStore) metaStore.reset();
        },
    };

    registerFileStoreForDiagnostics(store);
    return store;
}
