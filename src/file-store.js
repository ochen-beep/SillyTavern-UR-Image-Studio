// @ts-check
/**
 * Generic server-file JSON store for URIS.
 *
 * One logical value (array, object, whatever) per SillyTavern SERVER file,
 * `data/<user>/user/files/<name>`, read/written through the official user-files
 * surface — the same routes ST itself uses for chat attachments:
 *   POST /api/files/verify  { urls: [] }            → probe (is the surface here?)
 *   POST /api/files/upload  { name, data: base64 }  → atomic write
 *   GET  /user/files/<name>                          → static read
 *
 * Why not extensionSettings: ST's `saveSettingsDebounced` POSTs the WHOLE
 * settings.json (no merge, no lock — last writer wins, see
 * `public/script.js` saveSettings in the ST tree) and the server writes it with
 * `JSON.stringify(body, null, 4)`. The official extension guide says it plainly
 * under "Don't store large data in extensionSettings": settings are loaded into
 * memory and saved frequently, so large data causes performance issues. The
 * gallery index alone was 4,8 MB of a 7,8 MB settings.json, so every unrelated
 * settings change rewrote all of it.
 *
 * Contract: `createFileStore(config)` returns a store with an in-memory mirror.
 * Mutations are synchronous against the mirror and schedule an immediate full
 * write through a serialized loop (one write per settle, in order). Reads after
 * `ready()` are synchronous. This is the same shape as the original
 * `template-file-store.js`, generalized so gallery / references / presets reuse
 * one tested implementation instead of three copies.
 *
 * Modes: 'file' (the server surface answered and the mirror reflects the file),
 * 'readonly' (a refusal protects data from being overwritten), 'unknown' (the
 * surface has not answered yet — `ready()` keeps re-probing and stays pending;
 * with the settings.json fallback gone there is no honest data source to work
 * from, and a mutation built on nothing must not reach the file).
 *
 * Refusals protect user data from being overwritten rather than preserved:
 *   - the initial read failed for a non-404 reason → the mirror may be an empty
 *     base, so writes wait until a re-read confirms the file's existence
 *     (404 → safe to write; present → mode stays, writes refused for the session);
 *   - the document was written by a NEWER extension build (doc.v > version) →
 *     mode 'readonly': loaded best-effort, never "repaired" away by an older one;
 *   - the user-files surface itself is absent (probe 404 — old SillyTavern) →
 *     mode 'readonly' for the session: there is nowhere to store data, and
 *     pretending otherwise would lose it.
 *
 * Concurrent writers (`mergeWithServer: true`): the store writes the WHOLE
 * document from its in-memory mirror, so any writer that is not this session —
 * a second browser tab, a second SillyTavern instance, Syncthing syncing the
 * data folder between machines — silently rolls back everything that session
 * changed since the mirror loaded (observed 2026-09-14: a reference image
 * replaced on one machine reappeared old after the other machine's next write).
 * When the flag is set, the write loop re-reads the server file before every
 * upload and merges it with the mirror per record id, newest `updatedAt` wins:
 * additions on either side survive, genuine conflicts resolve by edit time, and
 * deletions are honored only when the other side did not modify the record. The
 * merged result becomes the mirror, so reads afterwards reflect the true state.
 *
 * Large collections (gallery index, reference pool) use the sharded sibling
 * `createShardedFileStore` — same contract, shard-sized writes; see
 * docs/2026-10-03-sharded-file-store-design.md.
 */

import { getCtx, log, warn, unrefTimer } from './core.js';
import { recordDiagnosticEvent } from './diagnostic-events.js';

/** Below this body size a keepalive unload flush is attempted (fetch keepalive cap ≈64KB). */
export const KEEPALIVE_BODY_LIMIT = 60 * 1024;
/** How often an unanswered user-files probe is retried inside `ready()`. */
const PROBE_RETRY_MS = 10 * 1000;
const FAILURE_TOAST_INTERVAL = 5000;
const VERIFY_URL = '/api/files/verify';
const UPLOAD_URL = '/api/files/upload';

const STORES = new Map();   // label → store, for the diagnostics panel

export function stHeaders() {
    const h = getCtx()?.getRequestHeaders?.();
    return { ...(h && typeof h === 'object' ? h : {}), 'Content-Type': 'application/json' };
}

/** UTF-8-safe base64 (stored values are user text, not Latin1). */
export function textToBase64(text) {
    const bytes = new TextEncoder().encode(String(text));
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

function clone(value) {
    return structuredClone(value);
}

function defaultCountEntries(value) {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === 'object') return Object.keys(value).length;
    return null;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Records with ids merge by id; arrays without ids and scalars are opaque. */
function asRecordArray(value) {
    return Array.isArray(value) && value.every(item => isPlainObject(item) && item.id != null) ? value : null;
}

function recordStamp(record) {
    return Number.isFinite(record?.updatedAt) ? record.updatedAt : 0;
}

function sameRecord(a, b) {
    if (a === b) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/**
 * Three-way merge of one record array: `baseArr` (state this session last
 * synced) against `serverArr` and the local mirror. Additions on either side
 * survive; a record only one side changed keeps that change; same-id conflicts
 * resolve by newest `updatedAt` (tie → local); a record absent on one side is a
 * deletion by that side and wins — unless the other side edited it since the
 * base, in which case the edit is preserved over the deletion.
 *
 * Stale whole-document copies (Syncthing conflict propagation roll the ENTIRE
 * file back) are detected as content regressions on shared records: a remote
 * record whose content differs from base and whose `updatedAt` predates the
 * base copy. That is a rollback, not an edit — the remote version keeps local —
 * and while rolling back, remote deletions are ignored too, so the rollback
 * cannot mass-delete records the other writer still has.
 * Returns null when nothing differs from local.
 */
function mergeRecordArray(baseArr, serverArr, localArr) {
    const toMap = arr => new Map((arr || []).map(r => [String(r.id), r]));
    const base = toMap(baseArr), server = toMap(serverArr), local = toMap(localArr);
    const regressed = id => {
        const was = base.get(id), remote = server.get(id);
        if (!was || !remote || sameRecord(was, remote)) return false;
        return recordStamp(remote) < recordStamp(was);
    };
    let rollback = false;
    for (const id of server.keys()) {
        if (base.has(id) && local.has(id) && regressed(id)) { rollback = true; break; }
    }
    const out = [];
    let changed = false;
    for (const record of localArr) {
        const id = String(record.id);
        const remote = server.get(id);
        if (!remote) {
            const known = base.has(id);
            if (known) {
                const was = base.get(id);
                if (!sameRecord(was, record)) { out.push(record); changed = true; }
                // untouched locally: deleted remotely — honored unless the whole
                // remote document is a stale rollback. KNOWN LIMITATION
                // (observed live 2026-10-03, two gallery tabs): the record is
                // dropped from `out`, but `changed` stays false, so a merge
                // whose ONLY effect is accepting remote deletions reports
                // "nothing to change" and the caller re-sends the unmerged
                // mirror — the deleted records come back. Making this
                // `changed = true` is NOT a safe fix: the merge read can be
                // older than syncBase (the session's own previous upload may
                // not have landed yet), and then an in-flight local addition
                // looks exactly like a remote deletion and gets destroyed.
                // Honest resolution needs tombstones or server-side
                // conditional writes (If-Match); until then, deletions by
                // another session can be resurrected by this session's next
                // full-document write.
                else if (rollback) { out.push(record); }
                continue;
            }
            out.push(record);   // added locally
            continue;
        }
        const was = base.get(id);
        const localChanged = was ? !sameRecord(was, record) : true;
        const remoteChanged = was ? !sameRecord(was, remote) : true;
        if (!was) { out.push(record); if (remote !== record) changed = true; continue; }
        if (localChanged && remoteChanged) {
            const win = recordStamp(remote) > recordStamp(record) ? remote : record;
            if (win !== record) changed = true;
            out.push(win);
        } else if (remoteChanged && !localChanged) {
            // Rollback guard: a sync conflict can propagate an OLD version of the
            // whole document. If the remote copy is stamped older than ours, it
            // is a stale rollback, not an edit — keep local. (Untouched local
            // records carry the stamp of the write that produced them, so a
            // genuine concurrent edit always has a newer or equal stamp.)
            const remoteStamp = recordStamp(remote), localStamp = recordStamp(record);
            if (localStamp > 0 && remoteStamp < localStamp) {
                out.push(record);
            } else {
                out.push(remote); changed = true;   // untouched here, updated there
            }
        } else {
            out.push(record);
        }
    }
    for (const [id, remote] of server) {
        if (local.has(id)) continue;
        if (base.has(id)) {
            const was = base.get(id);
            if (!sameRecord(was, remote)) { out.push(remote); changed = true; }  // edited remotely despite local deletion
            else if (rollback) { /* stale copy never had it — resurrection beats mass loss */ }
            // else: deleted locally → honored
            continue;
        }
        out.push(remote); changed = true;       // added remotely
    }
    return changed ? out : null;
}

/** Merge a whole document value; see `mergeRecordArray`. Null = nothing to change. */
export function mergeServerValue(baseValue, serverValue, localValue) {
    const rl = asRecordArray(localValue), rs = asRecordArray(serverValue);
    if (rl && rs) return mergeRecordArray(asRecordArray(baseValue) || [], rs, rl);
    if (isPlainObject(serverValue) && isPlainObject(localValue)) {
        const out = {};
        let changed = false;
        for (const key of new Set([...Object.keys(localValue), ...Object.keys(serverValue)])) {
            const local = localValue[key], server = serverValue[key];
            const base = baseValue?.[key];
            const la = asRecordArray(local), sa = asRecordArray(server);
            if (la && (sa || server === undefined)) {
                const merged = mergeRecordArray(asRecordArray(base) || [], sa || [], la);
                out[key] = merged ?? local;
                if (merged) changed = true;
            } else if (local !== undefined) {
                out[key] = local;   // scalars and mismatched shapes: local wins
            } else { out[key] = server; changed = true; }
        }
        return changed ? out : null;
    }
    return null;
}

/**
 * @typedef {object} FileStoreConfig
 * @property {string} name                Server file name. ASCII only — ST validates
 *                                        asset names against `[a-zA-Z0-9_\-.]+`.
 * @property {number} [version]           Document version stored as `v`.
 * @property {string} [key]               Property holding the value: `{ v, <key>: value }`.
 * @property {() => any} [empty]          Initial value when there is nothing to load.
 * @property {number} [keepaliveLimit]    Max body size for the unload flush.
 * @property {string} [label]             Human-readable name for logs / the diagnostics panel.
 * @property {() => void} [onWriteFailure] Extra failure notification (toast).
 * @property {(value: any) => number} [countEntries]
 * @property {boolean} [mergeWithServer] Re-read and merge the server document
 *                                        before every write (concurrent-writer
 *                                        safety). Off by default for stores
 *                                        whose documents are session-owned.
 */

/**
 * Create a file-backed store. The returned object is stable: `ready()` is
 * memoized, so calling it from every entry point is cheap.
 * @param {FileStoreConfig} config
 */
export function createFileStore(config) {
    const {
        name,
        version = 1,
        key = 'data',
        empty = () => null,
        keepaliveLimit = KEEPALIVE_BODY_LIMIT,
        label = name,
        onWriteFailure = null,
        countEntries = defaultCountEntries,
        probeRetryMs = PROBE_RETRY_MS,
        mergeWithServer = false,
    } = config;

    let mode = 'unknown';          // 'unknown' | 'file' | 'readonly'
    let readyPromise = null;       // memoized probe + load (retries inside while the surface is silent)
    let mirror = null;             // source of truth once ready
    // Mirror state the last confirmed server document was built from — the
    // three-way merge base for `mergeWithServer` writes. Null until loaded.
    let syncBase = null;
    // One-shot merge suppression for replace(): a backup restore must clobber
    // the server document, not merge the user's newer edits back in.
    let suppressMergeOnce = false;
    let pendingPayload = null;     // newest content not yet uploaded
    let writeJob = null;           // in-flight write loop (null when idle)
    // Content an unload keepalive flush sent while the write loop was parked in
    // an await. The keepalive and the loop's own upload are two concurrent
    // full-file writes whose ARRIVAL order is not guaranteed to match the send
    // order: without this marker an older in-flight upload can land after the
    // flushed newer payload and quietly regress the server file (the flushed
    // mutations are lost). The loop re-sends the current mirror after such a
    // race, so the file ends on the newest state regardless of arrival order.
    let unloadFlushedPayload = null;
    let lastWriteOk = true;
    let lastFailureToastAt = 0;
    // The initial read failed (non-404): file existence is unconfirmed, so a
    // full-file overwrite built on the (possibly empty) mirror is forbidden
    // until a re-read settles the question.
    let unreadableFile = false;
    // Session-level persist refusal. 'file-unreadable-at-load': the re-read
    // proved the file exists while the mirror was built without it.
    // 'newer-version': the document was written by a newer extension build.
    // 'no-user-files': the user-files surface is absent (old SillyTavern).
    let writeBlockedReason = null;
    const refusedNotified = new Set();
    const diagnostics = {
        label, mode: 'unknown', loaded: false, readResult: null,
        entries: null, bytes: null, lastWriteAt: null, lastWriteOk: null,
        lastError: null,
    };

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
        warn(`file-store[${label}]:`, cause?.message || cause);
        const now = Date.now();
        if (now - lastFailureToastAt < FAILURE_TOAST_INTERVAL) return;
        lastFailureToastAt = now;
        try {
            if (onWriteFailure) onWriteFailure(cause);
            else globalThis.toastr?.error?.(`Не удалось сохранить «${label}» на сервер.`);
        } catch { /* no toastr in tests */ }
    }

    // ── HTTP ──

    async function readFile() {
        const res = await fetch(`/user/files/${encodeURIComponent(name)}`, { method: 'GET', cache: 'no-store' });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`read failed: ${res.status}`);
        const text = await res.text();
        return text || null;
    }

    async function uploadFile(payload) {
        const res = await fetch(UPLOAD_URL, {
            method: 'POST',
            headers: stHeaders(),
            body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text().catch(() => '')}`);
    }

    /**
     * Parse the stored document. Returns the reason alongside the value so the
     * caller can tell "unusable" (safe to repair) from "written by a different
     * build" (must never be silently destroyed by a repair write).
     */
    function parseDoc(text) {
        let doc;
        try { doc = JSON.parse(text); } catch { return { reason: 'corrupt' }; }
        if (!doc || typeof doc !== 'object') return { reason: 'corrupt' };
        if (!Object.hasOwn(doc, key)) return { reason: 'corrupt' };
        // A document from a newer build cannot be managed by this one: load it
        // read-only, never repair it away.
        if (typeof doc.v === 'number' && doc.v > version) return { reason: 'newer', value: doc[key] };
        if (doc.v === version) return { reason: 'found', value: doc[key] };
        // A document from an OLDER build of this store: this build is the newer
        // authority, so the value loads (lazy migration) and the next persist
        // rewrites it with the current `v`. Bumping `version` without a shape
        // migrator is exactly the case this keeps safe — the old data is
        // adopted, never wiped; a shape-changing bump must add a real migrator.
        if (typeof doc.v === 'number' && doc.v < version) return { reason: 'older', value: doc[key] };
        return { reason: 'corrupt' };
    }

    /** Refuse session writes with a one-time explanation the user can act on. */
    function refusePersist(reason) {
        lastWriteOk = false;
        diagnostics.lastWriteOk = false;
        diagnostics.lastError = reason;
        if (refusedNotified.has(reason)) return Promise.resolve(false);
        refusedNotified.add(reason);
        emit('store-write-skipped', { store: label, reason, level: 'warn' });
        warn(`file-store[${label}]: writes refused (${reason})`);
        try {
            const messages = {
                'newer-version': `«${label}»: данные записаны более новой версией расширения — обновите UR Image Studio; запись отключена.`,
                'file-unreadable-at-load': `«${label}»: не удалось прочитать файл при запуске — запись заблокирована, чтобы не потерять данные. Перезагрузите страницу.`,
                'no-user-files': `«${label}»: SillyTavern не поддерживает файловое хранилище (обновите SillyTavern); запись отключена.`,
            };
            const message = messages[reason] || `«${label}»: запись отключена (${reason}).`;
            if (onWriteFailure) onWriteFailure(new Error(reason));
            else globalThis.toastr?.error?.(message);
        } catch { /* no toastr in tests */ }
        return Promise.resolve(false);
    }

    // ── Load ──

    /**
     * One probe + load attempt. Returns the store mode, or null when the
     * surface is unreachable right now (the caller retries).
     */
    async function detectAndLoadOnce() {
        const started = Date.now();

        let probe;
        try {
            probe = await fetch(VERIFY_URL, { method: 'POST', headers: stHeaders(), body: JSON.stringify({ urls: [] }) });
        } catch (cause) {
            // The surface is unreachable right now. Returning null sends the
            // caller back into the ready() retry loop: with no settings
            // fallback there is no honest data source to load, and a mutation
            // built on nothing must never reach the file.
            warn(`file-store[${label}]: user-files endpoint unreachable:`, cause?.message || cause);
            return null;
        }
        if (!probe.ok) {
            // The endpoint answered but does not exist (404 — old SillyTavern):
            // permanent for the session, nowhere to store data.
            mode = 'readonly';
            diagnostics.mode = mode;
            writeBlockedReason = 'no-user-files';
            mirror = empty();
            syncBase = clone(mirror);
            diagnostics.loaded = true;
            diagnostics.readResult = `probe-${probe.status}`;
            diagnostics.entries = countEntries(mirror);
            emit('store-mode', { store: label, result: 'readonly', reason: 'no-user-files' });
            log(`file-store[${label}]: mode=readonly (no user-files surface, probe ${probe.status})`);
            refusePersist('no-user-files');
            return mode;
        }

        mode = 'file';
        diagnostics.mode = mode;

        let text = null;
        let readResult = 'missing';
        let parsed = null;
        try {
            text = await readFile();
        } catch (cause) {
            readResult = 'error';
            warn(`file-store[${label}]: read failed; writes are withheld until the file's existence is settled:`, cause?.message || cause);
        }

        let fileValue = null;
        if (text) {
            parsed = parseDoc(text);
            readResult = parsed.reason;
            if (parsed.reason === 'found' || parsed.reason === 'older') fileValue = parsed.value;
        }

        // A corrupt parse may be a transient truncation (flaky network,
        // tunnel hiccup), not real damage: re-read before treating it as
        // such. Only a still-corrupt document counts as broken, and its text
        // is parked in a `.corrupt` side file before any repair write — the
        // repair must never be the step that loses data silently.
        if (readResult === 'corrupt') {
            const reread = await readFile().catch(() => null);
            if (reread !== null && reread !== undefined) {
                const rereadParsed = parseDoc(reread);
                if (rereadParsed.reason === 'found' || rereadParsed.reason === 'older') {
                    text = reread;
                    parsed = rereadParsed;
                    readResult = parsed.reason;
                    fileValue = parsed.value;
                    log(`file-store[${label}]: corrupt parse settled on re-read (${readResult}) — transient truncation`);
                }
            }
            if (readResult === 'corrupt' && text) {
                try {
                    await uploadFile({ name: `${name}.corrupt`, data: textToBase64(text) });
                    warn(`file-store[${label}]: corrupt document parked at ${name}.corrupt before repair`);
                } catch (cause) {
                    warn(`file-store[${label}]: corrupt side-file write failed (repair proceeds):`, cause?.message || cause);
                }
            }
        }

        // A document from a newer build cannot be managed by this one: load it
        // read-only, never repair it away.
        if (readResult === 'newer') {
            mode = 'readonly';
            diagnostics.mode = mode;
            mirror = parsed.value === undefined ? empty() : parsed.value;
            diagnostics.loaded = true;
            diagnostics.readResult = 'newer';
            diagnostics.entries = countEntries(mirror);
            diagnostics.bytes = text ? text.length : 0;
            emit('store-mode', { store: label, result: 'readonly', reason: 'newer-version' });
            emit('store-load', {
                store: label, result: 'newer', entries: diagnostics.entries,
                bytes: diagnostics.bytes, ms: Date.now() - started,
            });
            log(`file-store[${label}]: mode=readonly (newer-version document)`);
            refusePersist('newer-version');
            return mode;
        }

        // The initial read failed for a non-404 reason: file existence is now
        // unconfirmed, and the mirror may be an empty base. Writes are withheld
        // until the write loop re-reads the file and settles the question.
        unreadableFile = readResult === 'error';

        mirror = fileValue === null || fileValue === undefined ? empty() : fileValue;
        // Merge base: the server document this session last synced to. A found
        // (or lazy-migrated older-version) file is exactly that; with no usable
        // file the mirror is the best description of the server state
        // (nothing/repair) for a first merge.
        syncBase = readResult === 'found' || readResult === 'older' ? clone(fileValue) : clone(mirror);
        diagnostics.loaded = true;
        diagnostics.readResult = readResult;
        diagnostics.entries = countEntries(mirror);
        diagnostics.bytes = text ? text.length : 0;

        emit('store-mode', { store: label, result: 'file', reason: readResult });
        emit('store-load', {
            store: label, result: readResult, entries: diagnostics.entries,
            bytes: diagnostics.bytes, ms: Date.now() - started,
        });
        log(`file-store[${label}]: mode=file, loaded (${readResult}) — ${diagnostics.entries} entr(ies), ${diagnostics.bytes} bytes`);

        // Правка >keepalive-пейлоада прошлой сессии дореплейтируется штатной
        // записью (см. flushOnUnload): её данные не выбрасываются только потому,
        // что не влезли в keepalive-запрос при выгрузке страницы.
        replayStashedPayload();

        // A corrupt document is repaired with the empty mirror; a missing one
        // is not created until the first real mutation. An older-version
        // document was just adopted (lazy migration): rewrite it immediately so
        // the version stamp is current even if no mutation ever follows — a
        // second session must not see the store as "behind" again.
        if (readResult === 'corrupt' || readResult === 'older') await schedulePersist();
        return mode;
    }

    /**
     * Resolve the store mode once per session. While the user-files surface is
     * unreachable the promise stays pending and the probe repeats after the
     * throttle window: there is nothing honest to resolve with, and callers'
     * `await ready()` simply waits for storage to answer.
     */
    function ready() {
        if (!readyPromise) {
            readyPromise = (async () => {
                for (;;) {
                    const result = await detectAndLoadOnce();
                    if (result !== null) return result;
                    // unref: бесконечный probe-цикл не должен держать процесс Node
                    // живым в тестах (см. unrefTimer в core.js).
                    await new Promise(resolve => unrefTimer(setTimeout(resolve, probeRetryMs)));
                }
            })();
        }
        return readyPromise;
    }

    // ── Persist ──

    function buildPayload() {
        const json = JSON.stringify({ v: version, [key]: mirror });
        return { name, data: textToBase64(json), bytes: json.length };
    }

    /**
     * `mergeWithServer` stores must never clobber a concurrent writer's work:
     * re-read the server document and three-way merge it into the mirror before
     * building the payload. A failed or unreadable re-read degrades safely to
     * the plain mirror write (the pre-merge behavior).
     * @returns {Promise<boolean>} whether the merged content differs from what
     *          the caller wanted to send (i.e. the payload must be rebuilt)
     */
    async function mergeMirrorWithServer() {
        if (!mergeWithServer || suppressMergeOnce) { suppressMergeOnce = false; return false; }
        let text = null;
        try { text = await readFile(); } catch { return false; }
        if (text === null) return false;      // 404: the file is gone — writing the mirror is correct
        const parsed = parseDoc(text);
        if (parsed.reason !== 'found') return false;  // newer/corrupt: refuse to blend into it
        const merged = mergeServerValue(syncBase, parsed.value, mirror);
        if (merged === null) return false;
        mirror = merged;
        return true;
    }

    async function runWriteLoop() {
        let ok = true;
        let failed = null;
        try {
            while (true) {
                if (!pendingPayload) break;
                if (unreadableFile) {
                    // The initial read never settled whether this file exists.
                    // Re-read now: 404 → the empty mirror was a correct base and
                    // the write is safe; anything else → refuse this session.
                    let verdict;
                    try {
                        verdict = (await readFile()) === null ? 'absent' : 'present';
                    } catch {
                        verdict = 'unresolved';
                    }
                    if (verdict === 'present') {
                        writeBlockedReason = 'file-unreadable-at-load';
                        pendingPayload = null;
                        refusePersist(writeBlockedReason);
                        break;
                    }
                    if (verdict === 'unresolved') {
                        // Server still unreachable — keep the payload for the
                        // next mutation or flush, send nothing this round.
                        lastWriteOk = false;
                        diagnostics.lastWriteOk = false;
                        diagnostics.lastError = 'file-unreadable';
                        emit('store-write-skipped', { store: label, reason: 'file-unreadable', level: 'warn' });
                        break;
                    }
                    unreadableFile = false;
                }
                const started = Date.now();
                // Merge with the server document before sending (merge-enabled
                // stores only): a concurrent writer's records must survive this
                // session's full-document overwrite. The flag also marks whether
                // the payload was built before the merge read and must be
                // rebuilt from the merged mirror.
                let payload = pendingPayload;
                if (await mergeMirrorWithServer()) {
                    payload = buildPayload();
                    pendingPayload = payload;
                }
                const mirrorSent = clone(mirror);
                try {
                    await uploadFile({ name: payload.name, data: payload.data });
                } catch (cause) {
                    // The payload deliberately stays pending: an unload flush can
                    // still retry it, and the next mutation will re-send it too.
                    ok = false;
                    failed = { payload, cause, ms: Date.now() - started };
                    break;
                }
                // The upload made the server equal to mirrorSent: it is the base
                // for the next merge, not the mirror as it mutated during the send.
                syncBase = mirrorSent;
                // Clear only if nothing newer arrived while this upload was in
                // flight — otherwise the loop keeps going with the newer content.
                if (pendingPayload === payload) {
                    pendingPayload = null;
                } else if (pendingPayload === null && unloadFlushedPayload && unloadFlushedPayload !== payload) {
                    // An unload keepalive flew while this upload was in flight and
                    // carried newer content; this older upload may now have landed
                    // AFTER it (arrival order beats send order). Re-send the current
                    // mirror so the file ends on the newest state, not on the stale
                    // in-flight payload. Same-content flushes (marker === payload)
                    // need no rewrite — the loop would send byte-identical data.
                    pendingPayload = buildPayload();
                }
                // The marker is consumed: the just-sent payload plus the re-send
                // above both carry at-least-as-new content as any flush so far.
                // A flush firing later re-sets it during the next await.
                unloadFlushedPayload = null;
                diagnostics.lastWriteAt = new Date().toISOString();
                diagnostics.bytes = payload.bytes;
                diagnostics.entries = countEntries(mirror);
                emit('store-write', {
                    store: label, result: 'success', entries: diagnostics.entries,
                    bytes: payload.bytes, ms: Date.now() - started,
                });
                log(`file-store[${label}]: wrote ${payload.bytes} bytes (${diagnostics.entries} entr(ies))`);
            }
        } finally {
            writeJob = null;
        }
        if (failed) {
            lastWriteOk = false;
            diagnostics.lastWriteOk = false;
            diagnostics.lastError = String(failed.cause?.message || failed.cause);
            emit('store-write', {
                store: label, result: 'error', bytes: failed.payload.bytes,
                ms: failed.ms, level: 'error', reason: diagnostics.lastError,
            });
            notifyFailure(failed.cause);
        } else if (!writeBlockedReason && !unreadableFile) {
            // A refusal (blocked/unreadable) already reported itself; do not
            // reset its state just because the loop ended without a throw.
            lastWriteOk = true;
            diagnostics.lastWriteOk = true;
            diagnostics.lastError = null;
        }
        return ok;
    }

    /**
     * Schedule a durable write of the current mirror. Mutations issued while a
     * write is in flight coalesce into it — one upload per settle, in order.
     * @returns {Promise<boolean>} whether the content reached the server
     */
    function schedulePersist() {
        if (mirror === null) return Promise.resolve(false);

        if (writeBlockedReason) return refusePersist(writeBlockedReason);
        if (mode === 'readonly') return refusePersist('newer-version');
        if (mode !== 'file') return Promise.resolve(false);

        pendingPayload = buildPayload();
        if (!writeJob) writeJob = runWriteLoop();
        return writeJob;
    }

    /** Await quiescence: every mutation issued so far has reached the server. */
    async function flush() {
        let guard = 0;
        while (writeJob && guard++ < 1000) await writeJob;
        return lastWriteOk;
    }

    // ── Over-keepalive stash (unload → next session) ──

    const STASH_PREFIX = 'uris_pending_write:';

    /**
     * Дореплей payload'а, отложенного прошлой сессией при выгрузке страницы
     * (flushOnUnload: >keepaliveLimit не может ехать в keepalive-запросе).
     * Ставится после загрузки зеркала: stash — это полное зеркало умирающей
     * сессии, возвращается в него трёхсторонним слиянием (base = syncBase,
     * server = текущее зеркало, local = stash — локальные правки умирающей
     * сессии возвращаются, чужие параллельные записи выживают). Ключ в
     * localStorage удаляется только после КОНФИРМЁННОЙ записи — сбой посреди
     * реплея просто повторит его в следующей сессии (запись полнодокументная,
     * идемпотентная).
     */
    function replayStashedPayload() {
        if (typeof localStorage === 'undefined') return;
        let raw = null;
        try { raw = localStorage.getItem(`${STASH_PREFIX}${label}`); } catch { return; }
        if (!raw) return;
        try {
            const stashed = JSON.parse(raw);
            const dropStash = () => { try { localStorage.removeItem(`${STASH_PREFIX}${label}`); } catch { /* teardown */ } };
            if (!stashed || stashed.name !== name || typeof stashed.data !== 'string') { dropStash(); return; }
            const json = new TextDecoder().decode(Uint8Array.from(atob(stashed.data), c => c.charCodeAt(0)));
            const doc = JSON.parse(json);
            const stashedMirror = doc?.[key];
            if (stashedMirror === undefined) { dropStash(); return; }
            // null по контракту mergeServerValue = «слитый результат совпадает
            // с local» — целевое состояние и есть stash (например, сервер
            // пуст, а stash несёт чисто-локальные записи).
            const merged = mergeServerValue(syncBase, clone(mirror), stashedMirror);
            mirror = merged !== null ? merged : clone(stashedMirror);
            syncBase = clone(mirror);
            pendingPayload = buildPayload();
            const job = writeJob || (writeJob = runWriteLoop());
            void Promise.resolve(job).then(ok => {
                if (ok) {
                    dropStash();
                    emit('store-unload-replay', { store: label, result: 'delivered', bytes: stashed.bytes ?? null });
                } else {
                    // stash остаётся — следующая сессия повторит реплей
                    emit('store-unload-replay', { store: label, result: 'write-failed', level: 'warn' });
                }
            }).catch(() => { /* stash остаётся */ });
        } catch (cause) {
            // Битый stash — данные всё равно невосстановимы, убираем.
            try { localStorage.removeItem(`${STASH_PREFIX}${label}`); } catch { /* teardown */ }
            warn(`file-store[${label}]: stashed payload replay failed: ${cause?.message || cause}`);
        }
    }

    /**
     * Last-chance durability on page unload: re-send the newest unconfirmed
     * payload with `fetch keepalive` so the request may outlive the page. The
     * upload is a full-file atomic write, so this is idempotent. Bodies above
     * the keepalive cap cannot ride keepalive: the full payload is stashed in
     * localStorage и дореплейтируется следующей сессией (replayStashedPayload)
     * — мутация больше не теряется только из-за размера.
     */
    function flushOnUnload() {
        if (mode !== 'file' || !pendingPayload) return;
        if (writeBlockedReason || unreadableFile) {
            emit('store-unload-flush', {
                store: label, result: 'skipped',
                reason: writeBlockedReason || 'file-unreadable', bytes: pendingPayload.data.length,
            });
            return;
        }
        const payload = pendingPayload;
        if (payload.data.length > keepaliveLimit) {
            // localStorage синхронен и переживает закрытие вкладки; ключ
            // пер-стор (label). Квота: payload обычно ≤ несколько МБ.
            let stashed = false;
            try {
                if (typeof localStorage !== 'undefined') {
                    localStorage.setItem(`${STASH_PREFIX}${label}`, JSON.stringify({
                        name: payload.name, data: payload.data, bytes: payload.bytes, at: Date.now(),
                    }));
                    stashed = true;
                }
            } catch { /* quota exceeded / disabled — fall through to old behavior */ }
            emit('store-unload-flush', {
                store: label, result: stashed ? 'stashed' : 'skipped',
                reason: 'over-keepalive-limit', bytes: payload.data.length,
            });
            if (!stashed) warn(`file-store[${label}]: unload flush skipped, payload ${payload.data.length} bytes exceeds keepalive limit and stash failed`);
            return;
        }
        try {
            // Mark sent BEFORE the fetch: this fires from visibilitychange AND
            // pagehide, and a second caller must not re-send the same payload.
            pendingPayload = null;
            unloadFlushedPayload = payload;
            void fetch(UPLOAD_URL, {
                method: 'POST',
                headers: stHeaders(),
                body: JSON.stringify({ name: payload.name, data: payload.data }),
                keepalive: true,
            });
            emit('store-unload-flush', { store: label, result: 'sent', bytes: payload.data.length });
        } catch { /* nothing else can be done during teardown */ }
    }

    // ── Public API ──

    const store = {
        name,
        label,

        ready,
        mode: () => mode,
        isFileMode: () => mode === 'file',

        /** Synchronous read of the loaded mirror, cloned. Null before `ready()`. */
        snapshot() { return mirror === null ? null : clone(mirror); },

        /**
         * Replace the whole value and await durability. A restore must clobber
         * the server document — merging it with a concurrent writer's records
         * would resurrect exactly the state the backup rollback discards — so
         * the next write skips the pre-write merge.
         */
        async replace(value) {
            await ready();
            mirror = value === undefined ? empty() : value;
            suppressMergeOnce = true;
            return schedulePersist();
        },

        /**
         * Apply a synchronous mutator to the mirror and schedule the write. The
         * mutator's return value is passed through as the operation result.
         *
         * КОНТРАКТ (write-behind): промис резолвится, когда мутация ПРИМЕНЕНА
         * к зеркалу, запись ещё в очереди. Это отличается от sharded-близнеца
         * (write-through: там mutate ждёт сетевой записи) — не ровняй их молча.
         * Когда запись должна уже лежать на сервере (тесты, импорт, выгрузка
         * перед disable) — await store.flush() явно.
         *
         * `persist: false` is for recompute-then-compare flows (reconcile): the
         * caller mutates, decides whether anything actually changed, and calls
         * `persist()` only then. Without it a read path would rewrite the file
         * on every open.
         */
        async mutate(mutator, { persist: shouldPersist = true } = {}) {
            await ready();
            if (mirror === null) mirror = empty();
            const result = mutator(mirror);
            if (shouldPersist) schedulePersist();
            return result;
        },

        /** Write the current mirror now (used with `mutate(..., {persist:false})`). */
        persist() {
            return schedulePersist();
        },

        flush,
        flushOnUnload,

        /** Size/shape summary for the diagnostics panel and the footprint log. */
        footprint() {
            return {
                label,
                file: name,
                mode,
                entries: diagnostics.entries,
                bytes: diagnostics.bytes,
                lastWriteOk: diagnostics.lastWriteOk,
                lastError: diagnostics.lastError,
            };
        },

        diagnostics: () => ({ ...diagnostics }),

        /**
         * Test-only: drop all session state so a fresh probe can run.
         * Tests: `flush()` BEFORE `reset()` — reset does not cancel a write
         * loop parked mid-upload, and its continuation lands its document in
         * whatever fetch/map the next test installed (proven flake class).
         */
        reset() {
            mode = 'unknown';
            readyPromise = null;
            mirror = null;
            syncBase = null;
            suppressMergeOnce = false;
            pendingPayload = null;
            writeJob = null;
            lastWriteOk = true;
            lastFailureToastAt = 0;
            unreadableFile = false;
            writeBlockedReason = null;
            refusedNotified.clear();
            Object.assign(diagnostics, {
                mode: 'unknown', loaded: false, readResult: null, entries: null,
                bytes: null, lastWriteAt: null, lastWriteOk: null, lastError: null,
            });
        },
    };

    registerFileStoreForDiagnostics(store);
    return store;
}

/** Registered stores, for the Settings-tab storage panel. */
export function listFileStores() {
    return [...STORES.values()].map(store => store.footprint());
}

/** Flush every registered store (page unload / extension disable). */
export function flushAllFileStoresOnUnload() {
    for (const store of STORES.values()) store.flushOnUnload();
}

/** Await durability of every registered store (import paths and tests). */
export function flushAllFileStores() {
    return Promise.all([...STORES.values()].map(store => store.flush()));
}

/**
 * Version-contract parse for the sharded sibling: same refusal rules as
 * `parseDoc` (corrupt / newer / older / found) without the `[key]` extraction —
 * sharded docs carry `kind`/`store`/`id` alongside `v`, and the manifest value
 * is the whole body. `value` of `newer`/`found`/`older` is the whole doc.
 */
export function parseVersionedDoc(text, { version }) {
    let doc;
    try { doc = JSON.parse(text); } catch { return { reason: 'corrupt' }; }
    if (!doc || typeof doc !== 'object') return { reason: 'corrupt' };
    if (typeof doc.v === 'number' && doc.v > version) return { reason: 'newer', value: doc };
    if (doc.v === version) return { reason: 'found', value: doc };
    if (typeof doc.v === 'number' && doc.v < version) return { reason: 'older', value: doc };
    return { reason: 'corrupt' };
}

/** Diagnostics registry lives in file-store; the sharded store registers here too. */
export function registerFileStoreForDiagnostics(store) {
    STORES.set(store.label, store);
}

/**
 * Test-only: forget every registered store. Tests import the same module
 * instance across files in one process, so registration must be resettable.
 */
export function resetFileStoresForTests() {
    STORES.clear();
}
