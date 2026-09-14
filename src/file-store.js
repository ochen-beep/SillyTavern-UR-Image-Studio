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
 * Migration is never destructive-before-durable: the settings copy is only
 * dropped after a file write has been confirmed, so an interrupted migration
 * simply repeats on the next load.
 *
 * Legacy mode: when the user-files endpoints are unavailable (older ST) the
 * store reports mode 'legacy' and callers keep using their settings-backed
 * path — no data is moved and nothing breaks. A transient probe failure is
 * re-probed after a throttle window; a 404 on the endpoint itself is permanent.
 *
 * Two refusals protect user data from being overwritten rather than preserved:
 *   - the initial read failed for a non-404 reason → the mirror may be an empty
 *     base, so writes wait until a re-read confirms the file's existence
 *     (404 → safe to write; present → mode stays, writes refused for the session);
 *   - the document was written by a NEWER extension build (doc.v > version) →
 *     mode 'readonly': loaded best-effort, never "repaired" away by an older one.
 */

import { getCtx, log, warn } from './core.js';
import { recordDiagnosticEvent } from './diagnostic-events.js';

/** Below this body size a keepalive unload flush is attempted (fetch keepalive cap ≈64KB). */
export const KEEPALIVE_BODY_LIMIT = 60 * 1024;
/** How often a retryable legacy downgrade re-probes the user-files surface. */
const LEGACY_RETRY_MS = 10 * 1000;
const FAILURE_TOAST_INTERVAL = 5000;
const VERIFY_URL = '/api/files/verify';
const UPLOAD_URL = '/api/files/upload';

const STORES = new Map();   // label → store, for the diagnostics panel

function stHeaders() {
    const h = getCtx()?.getRequestHeaders?.();
    return { ...(h && typeof h === 'object' ? h : {}), 'Content-Type': 'application/json' };
}

/** UTF-8-safe base64 (stored values are user text, not Latin1). */
function textToBase64(text) {
    const bytes = new TextEncoder().encode(String(text));
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

function clone(value) {
    if (value === null || value === undefined) return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

/** Ids present in a record array — used to report what a stale settings copy held. */
function idsOf(value) {
    if (!Array.isArray(value)) return [];
    return value.map(item => (item && typeof item === 'object' ? item.id : undefined)).filter(id => id != null);
}

/** "Empty" as in "no legacy copy worth migrating": null, [], {} all count. */
function isEmptyValue(value) {
    if (value === null || value === undefined) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
}

function defaultCountEntries(value) {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === 'object') return Object.keys(value).length;
    return null;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Union the records a legacy session produced into the freshly loaded file
 * state, by `id`, file first. Used ONLY on the legacy→file retry transition of
 * stores whose settings copy is supposed to be gone (`stripLegacyOnLoad`):
 * there, anything the mirror holds beyond the file is work the session did
 * while the server surface was unreachable, and dropping it silently is worse
 * than the rare resurrection of an old record when a strip had failed earlier.
 * Returns null when nothing was appended or the shapes do not match.
 */
function mergeLegacyRecovery(fileValue, priorValue) {
    const additionsOf = (fileArr, priorArr) => {
        const ids = new Set(fileArr.filter(item => isPlainObject(item) && 'id' in item).map(item => item.id));
        return priorArr.filter(item => isPlainObject(item) && 'id' in item && !ids.has(item.id));
    };
    if (Array.isArray(fileValue) && Array.isArray(priorValue)) {
        const additions = additionsOf(fileValue, priorValue);
        return additions.length ? [...fileValue, ...additions] : null;
    }
    if (isPlainObject(fileValue) && isPlainObject(priorValue)) {
        const fileKeys = Object.keys(fileValue).sort();
        const priorKeys = Object.keys(priorValue).sort();
        const sameShape = fileKeys.length === priorKeys.length
            && fileKeys.every((k, i) => k === priorKeys[i] && Array.isArray(fileValue[k]) && Array.isArray(priorValue[k]));
        if (!sameShape) return null;
        const out = { ...fileValue };
        let changed = false;
        for (const k of fileKeys) {
            const additions = additionsOf(fileValue[k], priorValue[k]);
            if (additions.length) { out[k] = [...fileValue[k], ...additions]; changed = true; }
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
 * @property {() => any} [legacyRead]     Read the settings-backed copy (migration source).
 * @property {(value: any) => void} [legacyWrite]  Write the settings-backed copy (legacy mode).
 * @property {() => number|void} [legacyStrip]     Remove the settings copy; return freed bytes.
 * @property {(input: {fileValue: any, legacyValue: any}) => {value: any, migrate?: boolean}} [resolveLoad]
 *                                        Decide what the loaded value is. Default: union by id.
 * @property {boolean} [stripLegacyOnLoad] Drop the settings copy once the file is
 *                                        authoritative. False for stores that keep it as a
 *                                        downgrade fallback (templates); true for large ones,
 *                                        where keeping a copy would defeat the whole point.
 * @property {number} [keepaliveLimit]    Max body size for the unload flush.
 * @property {string} [label]             Human-readable name for logs / the diagnostics panel.
 * @property {() => void} [onWriteFailure] Extra failure notification (toast).
 * @property {(value: any) => number} [countEntries]
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
        legacyRead = () => null,
        legacyWrite = null,
        legacyStrip = null,
        stripLegacyOnLoad = false,
        keepaliveLimit = KEEPALIVE_BODY_LIMIT,
        label = name,
        onWriteFailure = null,
        countEntries = defaultCountEntries,
        legacyRetryMs = LEGACY_RETRY_MS,
    } = config;

    let mode = 'unknown';          // 'unknown' | 'file' | 'legacy' | 'readonly'
    let readyPromise = null;       // memoized probe + load/migrate
    let mirror = null;             // source of truth once ready
    let pendingPayload = null;     // newest content not yet uploaded
    let writeJob = null;           // in-flight write loop (null when idle)
    let lastWriteOk = true;
    let lastFailureToastAt = 0;
    let legacyStripped = false;
    // The initial read failed (non-404): file existence is unconfirmed, so a
    // full-file overwrite built on the (possibly empty) mirror is forbidden
    // until a re-read settles the question.
    let unreadableFile = false;
    // Session-level persist refusal. 'file-unreadable-at-load': the re-read
    // proved the file exists while the mirror was built without it.
    // 'newer-version': the document was written by a newer extension build.
    let writeBlockedReason = null;
    const refusedNotified = new Set();
    // A transient probe failure must not pin the whole session to legacy
    // settings mode: ready() re-probes after the throttle window and, on
    // recovery, unions the legacy-session work into the file state.
    let legacyRetryable = false;
    let lastLegacyAttemptAt = 0;
    const diagnostics = {
        label, mode: 'unknown', loaded: false, readResult: null,
        entries: null, bytes: null, lastWriteAt: null, lastWriteOk: null,
        lastError: null, freedBytes: null,
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
     * caller can tell "unusable" (safe to repair) from "written by a newer
     * build" (must never be overwritten by this older one).
     */
    function parseDoc(text) {
        let doc;
        try { doc = JSON.parse(text); } catch { return { reason: 'corrupt' }; }
        if (!doc || typeof doc !== 'object') return { reason: 'corrupt' };
        if (typeof doc.v === 'number' && doc.v > version) {
            return { reason: 'newer', value: Object.hasOwn(doc, key) ? doc[key] : undefined };
        }
        if (!Object.hasOwn(doc, key) || doc.v !== version) return { reason: 'corrupt' };
        return { reason: 'found', value: doc[key] };
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
            };
            const message = messages[reason] || `«${label}»: запись отключена (${reason}).`;
            if (onWriteFailure) onWriteFailure(new Error(reason));
            else globalThis.toastr?.error?.(message);
        } catch { /* no toastr in tests */ }
        return Promise.resolve(false);
    }

    // ── Load ──

    function readLegacy() {
        try {
            const value = legacyRead();
            return isEmptyValue(value) ? null : value;
        } catch (cause) {
            warn(`file-store[${label}]: legacy read failed:`, cause?.message || cause);
            return null;
        }
    }

    function resolveDefault({ fileValue, legacyValue }) {
        // A valid file is authoritative. The settings copy only ever feeds the
        // initial migration, so merging it back in cannot resurrect records the
        // user already deleted (that is the failure mode a union-by-id would
        // have introduced). Leftovers are reported instead of silently dropped.
        if (fileValue === null || fileValue === undefined) {
            return { value: legacyValue ?? empty(), migrate: false };
        }
        const orphans = legacyValue !== null && legacyValue !== undefined
            ? idsOf(legacyValue).filter(id => !idsOf(fileValue).includes(id))
            : [];
        if (orphans.length) {
            warn(`file-store[${label}]: ignoring ${orphans.length} settings entr(ies) absent from the file`);
            emit('store-load', { store: label, result: 'file-authoritative', orphans: orphans.length, level: 'warn' });
            // For stores whose settings copy is supposed to be GONE, orphans
            // mean real divergence (a failed strip, or work written by a legacy
            // session) — that is worth a visible heads-up, not just console noise.
            // Templates keep their copy by design, so they stay console-only.
            if (stripLegacyOnLoad) {
                try {
                    globalThis.toastr?.warning?.(`«${label}»: ${orphans.length} записей в настройках не совпадают с файлом. Подробности — в диагностике.`);
                } catch { /* no toastr in tests */ }
            }
        }
        return { value: fileValue, migrate: false };
    }

    const resolveLoad = config.resolveLoad || resolveDefault;

    /** Drop the settings copy. Only ever called after the file is authoritative. */
    function stripLegacy() {
        if (!legacyStrip || legacyStripped) return;
        legacyStripped = true;
        try {
            const freed = legacyStrip();
            const freedBytes = typeof freed === 'number' ? freed : null;
            diagnostics.freedBytes = freedBytes;
            emit('store-strip', { store: label, freedBytes });
            log(`file-store[${label}]: stripped legacy settings copy`, freedBytes === null ? '' : `(freed ${freedBytes} bytes)`);
        } catch (cause) {
            legacyStripped = false;   // retry on the next load
            warn(`file-store[${label}]: legacy strip failed:`, cause?.message || cause);
        }
    }

    /**
     * Stay on the settings-backed store. The legacy value still has to reach the
     * mirror, otherwise the first mutation would build on an empty base and wipe
     * whatever the settings copy held.
     */
    function enterLegacyMode(reason) {
        mode = 'legacy';
        diagnostics.mode = mode;
        // A network blip on the probe is transient — retry later. A 404 on the
        // endpoint itself means this SillyTavern has no user-files surface at
        // all: permanent for the session, no point re-probing.
        legacyRetryable = reason === 'probe-error';
        lastLegacyAttemptAt = Date.now();
        const legacyValue = readLegacy();
        mirror = legacyValue === null ? empty() : legacyValue;
        diagnostics.loaded = true;
        diagnostics.entries = countEntries(mirror);
        emit('store-mode', { store: label, result: 'legacy', reason });
        log(`file-store[${label}]: mode=legacy (${reason}) — staying on settings`);
        return mode;
    }

    async function detectAndLoad({ retry = false } = {}) {
        const started = Date.now();
        // The mirror as the retry found it: in legacy mode it holds the base
        // plus whatever the session wrote while the surface was unreachable.
        const priorMirror = retry ? mirror : null;

        let probe;
        try {
            probe = await fetch(VERIFY_URL, { method: 'POST', headers: stHeaders(), body: JSON.stringify({ urls: [] }) });
        } catch (cause) {
            warn(`file-store[${label}]: user-files endpoint unavailable:`, cause?.message || cause);
            return enterLegacyMode('probe-error');
        }
        if (!probe.ok) return enterLegacyMode(`probe-${probe.status}`);

        // Set before the initial persist so migration writes are not skipped.
        mode = 'file';
        diagnostics.mode = mode;
        legacyRetryable = false;

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
            if (parsed.reason === 'found') fileValue = parsed.value;
        }

        // A document from a newer build cannot be managed by this one: load it
        // read-only, never repair it away, never strip the settings copy.
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

        const legacyValue = readLegacy();
        const resolved = resolveLoad({ fileValue, legacyValue });
        mirror = resolved.value === undefined ? empty() : resolved.value;
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

        // Retry transition legacy→file: carry the session's legacy-mode work
        // into the file state and persist the union BEFORE the settings copy
        // is stripped (same never-destructive-before-durable ordering).
        if (retry && stripLegacyOnLoad && priorMirror && readResult === 'found') {
            const merged = mergeLegacyRecovery(mirror, priorMirror);
            if (merged !== null) {
                mirror = merged;
                diagnostics.entries = countEntries(mirror);
                log(`file-store[${label}]: merged legacy-session records into the recovered file`);
                await schedulePersist();
            }
        }

        if (readResult === 'found') {
            // The file is authoritative — the settings copy is now dead weight.
            if (stripLegacyOnLoad) stripLegacy();
            return mode;
        }

        // Nothing to migrate and nothing to repair: do not create an empty file.
        if (legacyValue === null && readResult !== 'corrupt') return mode;

        // Migration (or corrupt-file repair): persist FIRST, strip only once durable.
        if (legacyValue !== null) {
            emit('store-migrate', { store: label, result: 'started', entries: countEntries(mirror), source: 'settings' });
            log(`file-store[${label}]: migrating ${countEntries(mirror)} entr(ies) from settings`);
        }
        const uploaded = await schedulePersist();
        if (uploaded && stripLegacyOnLoad) stripLegacy();
        return mode;
    }

    /**
     * Resolve the store mode (and perform load/migration) once per session.
     * A retryable legacy downgrade re-runs this through `ready()` after the
     * throttle window; a session blocked for safety stays blocked.
     */
    function ready() {
        if (!readyPromise) {
            readyPromise = detectAndLoad();
            return readyPromise;
        }
        // A transient probe failure downgraded this session to legacy mode.
        // Re-probe (throttled) so one blip at startup doesn't pin every write
        // to settings.json for the rest of the session.
        if (mode === 'legacy' && legacyRetryable && Date.now() - lastLegacyAttemptAt >= legacyRetryMs) {
            readyPromise = detectAndLoad({ retry: true });
        }
        return readyPromise;
    }

    // ── Persist ──

    function buildPayload() {
        const json = JSON.stringify({ v: version, [key]: mirror });
        return { name, data: textToBase64(json), bytes: json.length };
    }

    async function runWriteLoop() {
        let ok = true;
        let failed = null;
        try {
            while (true) {
                const payload = pendingPayload;
                if (!payload) break;
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
                try {
                    await uploadFile({ name: payload.name, data: payload.data });
                } catch (cause) {
                    // The payload deliberately stays pending: an unload flush can
                    // still retry it, and the next mutation will re-send it too.
                    ok = false;
                    failed = { payload, cause, ms: Date.now() - started };
                    break;
                }
                // Clear only if nothing newer arrived while this upload was in
                // flight — otherwise the loop keeps going with the newer content.
                if (pendingPayload === payload) pendingPayload = null;
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

        if (mode === 'legacy') {
            if (!legacyWrite) return Promise.resolve(false);
            try {
                legacyWrite(clone(mirror));
                diagnostics.lastWriteAt = new Date().toISOString();
                emit('store-write', { store: label, result: 'settings', entries: countEntries(mirror) });
                return Promise.resolve(true);
            } catch (cause) {
                lastWriteOk = false;
                notifyFailure(cause);
                return Promise.resolve(false);
            }
        }
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

    /**
     * Last-chance durability on page unload: re-send the newest unconfirmed
     * payload with `fetch keepalive` so the request may outlive the page. The
     * upload is a full-file atomic write, so this is idempotent. Bodies above
     * the keepalive cap are skipped (logged, not silently dropped).
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
            emit('store-unload-flush', { store: label, result: 'skipped', reason: 'over-keepalive-limit', bytes: payload.data.length });
            warn(`file-store[${label}]: unload flush skipped, payload ${payload.data.length} bytes exceeds keepalive limit`);
            return;
        }
        try {
            // Mark sent BEFORE the fetch: this fires from visibilitychange AND
            // pagehide, and a second caller must not re-send the same payload.
            pendingPayload = null;
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

        /** Replace the whole value and await durability. */
        async replace(value) {
            await ready();
            mirror = value === undefined ? empty() : value;
            return schedulePersist();
        },

        /**
         * Apply a synchronous mutator to the mirror and schedule the write. The
         * mutator's return value is passed through as the operation result.
         * Works in both modes: legacy mode writes the settings copy back.
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

        /** Test-only: drop all session state so a fresh probe can run. */
        reset() {
            mode = 'unknown';
            readyPromise = null;
            mirror = null;
            pendingPayload = null;
            writeJob = null;
            lastWriteOk = true;
            lastFailureToastAt = 0;
            legacyStripped = false;
            unreadableFile = false;
            writeBlockedReason = null;
            refusedNotified.clear();
            legacyRetryable = false;
            lastLegacyAttemptAt = 0;
            Object.assign(diagnostics, {
                mode: 'unknown', loaded: false, readResult: null, entries: null,
                bytes: null, lastWriteAt: null, lastWriteOk: null, lastError: null, freedBytes: null,
            });
        },
    };

    STORES.set(label, store);
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
 * Test-only: forget every registered store. Tests import the same module
 * instance across files in one process, so registration must be resettable.
 */
export function resetFileStoresForTests() {
    STORES.clear();
}

/**
 * Measure the current settings footprint of the module. This is the number the
 * whole exercise is about: a 7,8 MB settings.json should drop to a few hundred KB
 * once gallery/references/presets live in files.
 * @returns {{settingsBytes: number, moduleBytes: number, entries: {[k: string]: number}}}
 */
export function measureSettingsFootprint(moduleName) {
    const empty = { settingsBytes: 0, connectionsBytes: 0, entries: {} };
    const ctx = getCtx();
    const settings = ctx?.extensionSettings?.[moduleName];
    if (!settings) return empty;
    // Serialization is the measurement, and it runs on a UI render path — a
    // circular or exotic value must degrade to a zero row, never break the tab.
    try {
        const moduleJson = JSON.stringify(settings);
        const connections = settings.imageConnections;
        const entries = {};
        if (connections && typeof connections === 'object') {
            for (const [k, v] of Object.entries(connections)) {
                if (Array.isArray(v)) entries[k] = v.length;
            }
        }
        return {
            settingsBytes: moduleJson.length,
            connectionsBytes: connections ? JSON.stringify(connections).length : 0,
            entries,
        };
    } catch (cause) {
        warn('file-store: settings footprint unavailable:', cause?.message || cause);
        return empty;
    }
}
