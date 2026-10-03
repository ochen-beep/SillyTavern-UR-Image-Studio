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
 * shard size. Manifest rows are derived data, merged with the server copy the
 * same way; a foreign shard unknown to this session is adopted, never clobbered.
 *
 * Modes follow file-store: 'unknown' → 'file' | 'readonly'. Extra refusal
 * reason: 'shard-unreadable' — the manifest names a shard the server cannot
 * deliver (404/corrupt/newer): the merge base is incomplete, so writes are
 * refused for the session instead of silently clobbering the missing part.
 */

import { log, warn } from './core.js';
import { recordDiagnosticEvent } from './diagnostic-events.js';
import {
    KEEPALIVE_BODY_LIMIT, textToBase64, stHeaders, mergeServerValue,
    parseVersionedDoc, registerFileStoreForDiagnostics,
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
    if (!Array.isArray(records)) return { reason: 'corrupt' };
    return { reason: parsed.reason, value: records };
}

// ── Store factory ── (capabilities accumulate in Tasks 3–9)

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
    } = config;

    const shardFileName = id => `${shardPrefix}${id}.json`;

    let mode = 'unknown';
    let readyPromise = null;
    let mirror = null;             // logical value; same shape as a file-store mirror
    let shards = [];               // manifest rows [{id, count, min, max}], id ASC
    let shardState = new Map();    // id → { records: [...], base: [...] | null }
    let recordShard = new Map();   // record id → shard id (placement, frozen)
    let dirtyShards = new Set();
    let emptyShards = new Set();   // shards to overwrite as `records: []` and drop
    let manifestDirty = false;
    let suppressMergeOnce = false; // migration / replace clobber the server, no merge
    let writeJob = null;
    let lastWriteOk = true;
    let lastFailureToastAt = 0;
    let totalBytes = null;
    let lastError = null;
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

    // ── Load ──

    /**
     * Load every shard the manifest names, in parallel. Any undeliverable
     * shard (404/corrupt/newer) makes the whole store readonly: the merge base
     * would be incomplete and a write could silently clobber the missing part.
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
                return { id: row.id, reason: 'missing' };
            }
        }));
        const bad = results.find(result => result.reason !== 'ok');
        if (bad) {
            mode = 'readonly';
            emit('store-mode', { store: label, result: 'readonly', reason: 'shard-unreadable', shard: bad.id });
            log(`sharded-store[${label}]: mode=readonly (shard ${bad.id} ${bad.reason})`);
            refusePersist('shard-unreadable');
            return false;
        }
        for (const result of results) adoptShard(result.id, result.records);
        return true;
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
            const verdict = await attemptMigration();
            if (verdict === 'unresolved') return null;   // monolith unreadable right now — retry
            if (verdict === 'refused') return mode;
            if (verdict === 'fresh') {
                mirror = empty();
                emit('store-mode', { store: label, result: 'file', reason: 'missing' });
                emit('store-load', { store: label, result: 'missing', entries: countEntries(mirror), bytes: 0, ms: Date.now() - started });
            }
            return mode;   // 'migrated': mirror is built, diagnostics emitted inside
        }

        const parsed = parseManifest(text, version);
        if (parsed.reason === 'newer') {
            mode = 'readonly';
            emit('store-mode', { store: label, result: 'readonly', reason: 'newer-version' });
            refusePersist('newer-version');
            return mode;
        }
        if (parsed.reason === 'corrupt') {
            // Task 8 wires rebuildFromScan() here. Until then: empty mirror.
            mirror = empty();
            emit('store-mode', { store: label, result: 'file', reason: 'corrupt-manifest' });
            return mode;
        }

        mirror = empty();
        const ok = await loadShards(parsed.value.shards || []);
        if (!ok) return mode;
        rebuildMirrorFromShards();
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
     * Place one new record into the newest shard (opening the next one at
     * target size). Task 5 adds the out-of-range branch.
     */
    function placeRecord(record) {
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
        for (const record of list) {
            const id = String(record.id);
            seen.add(id);
            const sid = recordShard.get(id);
            if (sid === undefined) {
                placeRecord(record);
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
            dirtyShards.add(sid);
            changed = true;
        }
        if (changed) manifestDirty = true;
        return changed;
    }

    // ── Persist (minimal core; Task 6 replaces with the merge loop) ──

    function schedulePersist() {
        if (mirror === null) return Promise.resolve(false);
        if (mode === 'readonly') { refusePersist('newer-version'); return Promise.resolve(false); }
        if (mode !== 'file') return Promise.resolve(false);
        if (!writeJob) writeJob = runWriteLoop();
        return writeJob;
    }

    /** Upload every dirty shard, then the manifest. true = everything landed. */
    async function runWriteLoop() {
        let ok = true;
        try {
            while (dirtyShards.size || manifestDirty) {
                const id = dirtyShards.values().next().value;
                if (id !== undefined) {
                    dirtyShards.delete(id);
                    const state = shardState.get(id);
                    try {
                        totalBytes = await uploadDoc(shardFileName(id), shardDoc(label, version, id, state.records));
                        state.base = clone(state.records);
                    } catch (cause) {
                        dirtyShards.add(id);
                        lastWriteOk = false;
                        lastError = String(cause?.message || cause);
                        emit('store-write', { store: label, result: 'error', shard: id, level: 'error', reason: lastError });
                        notifyFailure(cause);
                        ok = false;
                        break;
                    }
                    continue;
                }
                manifestDirty = false;
                try {
                    totalBytes = await uploadDoc(manifestName, manifestDoc(label, version, shards.map(row => ({ ...row }))));
                } catch (cause) {
                    manifestDirty = true;
                    lastWriteOk = false;
                    lastError = String(cause?.message || cause);
                    emit('store-write', { store: label, result: 'error', shard: 'manifest', level: 'error', reason: lastError });
                    notifyFailure(cause);
                    ok = false;
                    break;
                }
            }
        } finally {
            writeJob = null;
        }
        if (ok) { lastWriteOk = true; lastError = null; }
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
            emit('store-mode', { store: label, result: 'readonly', reason: 'newer-version' });
            refusePersist('newer-version');
            return 'refused';
        }
        const body = parsed.reason === 'found' || parsed.reason === 'older' ? parsed.value : null;
        if (body === null) {
            // Already migrated (tombstoned monolith): nothing to move, nothing
            // to write — the store simply comes up empty.
            mirror = empty();
            return 'migrated';
        }
        // Monolith values differ by store: the gallery is a bare array, refs is
        // `{ refs, folders }` — the sharded collection rides `shardedKey`.
        const records = body === null ? []
            : (shardedKey ? (Array.isArray(body[shardedKey]) ? body[shardedKey] : []) : body);
        const ordered = oldestFirst(records);
        for (let i = 0; i < ordered.length; i += shardTarget) {
            const chunk = ordered.slice(i, i + shardTarget).map(record => record);
            if (append === 'front') chunk.reverse();   // shard-internal newest-first
            const id = nextShardId();
            adoptShard(id, chunk);
            dirtyShards.add(id);
        }
        rebuildMirrorFromShards();   // the mirror must reflect the migrated records
        manifestDirty = true;
        const outcome = await runWriteLoop();
        if (!outcome) return 'unresolved';
        await uploadDoc(monolithName, tombstoneDoc(label, version));
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
            // Awaited: when `mutate` resolves, its write has landed (callers
            // and tests read server state right after; the loop still coalesces
            // mutations issued while it is in flight).
            if (changed && shouldPersist) await schedulePersist();
            return result;
        },
        async replace(value) { mirror = value; },                          // Task 7
        persist() { return schedulePersist(); },
        async flush() { return lastWriteOk; },                             // Task 9
        flushOnUnload() {},                                                // Task 9
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
            suppressMergeOnce = false;
            writeJob = null;
            lastWriteOk = true;
            lastFailureToastAt = 0;
            totalBytes = null;
            lastError = null;
            refusedNotified.clear();
        },
    };

    registerFileStoreForDiagnostics(store);
    return store;
}
