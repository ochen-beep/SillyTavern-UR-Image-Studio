/**
 * Metadata-only diagnostic event journal.
 * This module intentionally has no core.js import so lifecycle logging cannot
 * create a core -> journal -> core initialization cycle.
 */

export const LF_DIAGNOSTIC_EVENTS = 'uris_event_log';
export const MAX_DIAGNOSTIC_EVENTS = 180;
const MAX_EVENT_CHARS = 1200;
const PERSIST_DELAY_MS = 500;

let events = [];
let loaded = false;
let sessionId = createSessionId();
let timer = null;
let inFlight = Promise.resolve();
let suppressWrites = false;

function createSessionId() {
    try {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().slice(0, 12);
    } catch { /* fallback below */ }
    return Math.random().toString(36).slice(2, 14);
}

export function hashDiagnosticId(value) {
    const text = String(value ?? '');
    if (!text) return null;
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `h${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function localforage() {
    try { return globalThis.SillyTavern?.libs?.localforage || null; } catch { return null; }
}

function safeString(value, limit = MAX_EVENT_CHARS) {
    const text = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit)} …(truncated)` : text;
}

function safeValue(value, depth = 0) {
    if (depth > 3 || value == null) return value ?? null;
    if (typeof value === 'string') return safeString(value, 240);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 12).map(item => safeValue(item, depth + 1));
    if (typeof value !== 'object') return String(value);
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 24)) {
        if (/(?:api[-_]?key|authorization|token|password|secret|credential|prompt|body|response)/i.test(key)) {
            if (key === 'prompt') out[key] = { chars: typeof item === 'string' ? item.length : null };
            else out[key] = '<redacted>';
        } else {
            out[key] = safeValue(item, depth + 1);
        }
    }
    return out;
}

function emitChanged() {
    // The journal is intentionally storage-first. It does not dispatch a
    // synchronous window event because callers may be inside SillyTavern event
    // handlers whose tests and lifecycle depend on exact event ordering.
}

async function readPersisted() {
    const lf = localforage();
    if (!lf) return [];
    try {
        const value = await lf.getItem(LF_DIAGNOSTIC_EVENTS);
        return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
    } catch { return []; }
}

function schedulePersist() {
    if (!loaded || suppressWrites) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
        timer = null;
        const snapshot = events.slice();
        inFlight = inFlight.then(async () => {
            if (suppressWrites) return;
            const lf = localforage();
            if (!lf) return;
            try { await lf.setItem(LF_DIAGNOSTIC_EVENTS, snapshot); } catch { /* non-critical */ }
        });
    }, PERSIST_DELAY_MS);
}

export function getDiagnosticSessionId() { return sessionId; }
export function isDiagnosticEventsLoaded() { return loaded; }

export function recordDiagnosticEvent(event, details = {}) {
    const input = event && typeof event === 'object' ? event : { event, details };
    const eventDetails = event && typeof event === 'object' && Object.hasOwn(event, 'details')
        ? event.details
        : details;
    const entry = {
        ts: new Date().toISOString(),
        sessionId,
        event: safeString(input.event || 'event', 120),
        level: input.level === 'error' || input.level === 'warn' ? input.level : 'log',
        requestId: input.requestId || null,
        chatHash: input.chatHash || null,
        msgId: input.msgId ?? null,
        queueId: input.queueId || null,
        stage: input.stage || null,
        connId: input.connId || null,
        routeId: input.routeId || null,
        modelId: input.modelId || null,
        generationContract: input.generationContract || null,
        operation: input.operation || null,
        delivery: input.delivery || null,
        bodyKind: input.bodyKind || null,
        status: Number.isFinite(input.status) ? input.status : null,
        outcome: input.outcome || null,
        durationMs: Number.isFinite(input.durationMs) ? Math.round(input.durationMs) : null,
        referenceCount: Number.isFinite(input.referenceCount) ? input.referenceCount : null,
        details: safeValue(eventDetails),
    };
    events.push(entry);
    while (events.length > MAX_DIAGNOSTIC_EVENTS) events.shift();
    emitChanged();
    schedulePersist();
    return entry;
}

export async function loadDiagnosticEvents() {
    const persisted = await readPersisted();
    if (persisted.length) {
        const keep = Math.max(0, MAX_DIAGNOSTIC_EVENTS - events.length);
        const persistedTail = keep > 0 ? persisted.slice(-keep) : [];
        events = [...persistedTail, ...events].slice(-MAX_DIAGNOSTIC_EVENTS);
    }
    loaded = true;
    schedulePersist();
    emitChanged();
    return listDiagnosticEvents();
}

export function listDiagnosticEvents() { return events.map(item => structuredClone(item)); }

export function flushDiagnosticEvents() {
    if (timer) {
        clearTimeout(timer);
        timer = null;
        const snapshot = events.slice();
        inFlight = inFlight.then(async () => {
            if (suppressWrites) return;
            const lf = localforage();
            if (!lf) return;
            try { await lf.setItem(LF_DIAGNOSTIC_EVENTS, snapshot); } catch { /* non-critical */ }
        });
    }
    return inFlight;
}

export async function clearDiagnosticEvents() {
    suppressWrites = true;
    if (timer) { clearTimeout(timer); timer = null; }
    // Start from an empty in-memory journal before waiting on the previous
    // write. Events created while the clear is in flight are retained and
    // persisted after the empty store is established.
    events = [];
    let cleared = true;
    try { await inFlight; } catch { /* prior write is best effort */ }
    try { await localforage()?.removeItem?.(LF_DIAGNOSTIC_EVENTS); }
    catch { cleared = false; }
    loaded = true;
    suppressWrites = false;
    schedulePersist();
    emitChanged();
    return cleared;
}

export function resetDiagnosticEventsForTests() {
    if (timer) clearTimeout(timer);
    timer = null;
    events = [];
    loaded = false;
    sessionId = createSessionId();
    inFlight = Promise.resolve();
    suppressWrites = false;
}
