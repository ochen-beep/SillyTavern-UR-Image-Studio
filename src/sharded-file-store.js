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
            // No manifest: fresh store or migration candidate. Task 4 wires
            // attemptMigration() here; until then treat as fresh.
            mirror = empty();
            emit('store-mode', { store: label, result: 'file', reason: 'missing' });
            emit('store-load', { store: label, result: 'missing', entries: countEntries(mirror), bytes: 0, ms: Date.now() - started });
            return mode;
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

    const store = {
        label,
        name: manifestName,
        manifestName,
        shardPrefix,

        ready,
        mode: () => mode,
        isFileMode: () => mode === 'file',
        snapshot() { return mirror === null ? null : clone(mirror); },
        async mutate(mutator, { persist: shouldPersist = true } = {}) {   // Task 4
            if (mirror === null) mirror = empty();
            return mutator(mirror);
        },
        async replace(value) { mirror = value; },                          // Task 7
        persist() { return Promise.resolve(true); },                       // Task 4
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
