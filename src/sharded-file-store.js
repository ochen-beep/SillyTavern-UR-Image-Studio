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

function shardDoc(store, version, id, records) {
    return { v: version, kind: 'shard', store, id, records };
}

function manifestDoc(store, version, shards) {
    return { v: version, kind: 'manifest', store, shards };
}

function tombstoneDoc(store, version) {
    return { v: version, kind: 'migrated', store };
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
        monolithName = null,
        monolithKey = 'data',
        shardTarget = 250,
        append = 'front',
        placeByStamp = false,
        placeStamp = r => (Number.isFinite(r?.createdAt) ? r.createdAt : 0),
        empty = () => [],
        shardedKey = null,
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

    // ── Placement state helpers ── (filled in Task 3)

    const store = {
        label,
        name: manifestName,
        manifestName,
        shardPrefix,

        ready: () => readyPromise || (readyPromise = Promise.resolve('file').then(result => {
            mode = result;
            if (mirror === null) mirror = empty();
            return result;
        })),   // Task 3 replaces with the real probe + load
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
