// @ts-check
/** Browser-local pending generation records. These never resume provider requests. */
import { serialize } from './serialize.js';

const KEY = 'uris_pending_images';
const BROWSER_KIND = 'browserRequest';
const MAX_PENDING_BROWSER_REQUESTS = 50;
const PENDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// «Не отправлен» — запрос до провайдера не дошёл, денег нет: страховке
// нечего хранить неделю, сутки достаточно.
const PENDING_NOT_STARTED_MS = 24 * 60 * 60 * 1000;
const ACTIVE_PENDING_STATUSES = new Set(['notStarted', 'dispatchingUnknown', 'resultReceived']);

function lf() { return SillyTavern.libs.localforage; }

function clone(value) {
    return structuredClone(value);
}

function cloneFreeze(value) {
    return Object.freeze(structuredClone(value));
}

async function readRecords() {
    const records = await lf().getItem(KEY);
    return Array.isArray(records) ? records.map(item => cloneFreeze(item)) : [];
}

async function writeRecords(records) {
    await lf().setItem(KEY, clone(records));
}

async function persistRecords(records) {
    if (records.length) await writeRecords(records);
    else await lf().removeItem(KEY);
}

// Save/update/discard/clear all use one read-modify-write queue. Multiple
// generations can finish close together; without this mutex, the last writer
// could silently discard another request's recovery record. list() joins the
// same queue, so a read never lands between a write's read and write phases.
const WRITE_KEY = 'uris-pending-images';
function enqueueWrite(task) {
    return serialize(WRITE_KEY, task);
}

async function list() {
    return serialize(WRITE_KEY, async () => readRecords());
}

function isRetainedPending(item, now = Date.now()) {
    if (item?.kind !== BROWSER_KIND || !ACTIVE_PENDING_STATUSES.has(item.status)) return false;
    if (!item.createdAt) return true;
    const createdAt = Date.parse(item.createdAt);
    if (!Number.isFinite(createdAt)) return true;
    const retentionMs = item.status === 'notStarted' ? PENDING_NOT_STARTED_MS : PENDING_RETENTION_MS;
    return now - createdAt <= retentionMs;
}

function retainPendingRecords(records, now = Date.now()) {
    const other = records.filter(item => item?.kind !== BROWSER_KIND);
    const pending = records.filter(item => isRetainedPending(item, now)).slice(-MAX_PENDING_BROWSER_REQUESTS);
    return [...other, ...pending];
}

function emitPendingChanged() {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try { window.dispatchEvent(new CustomEvent('uris:pending-changed')); } catch { /* node/test runtime */ }
    }
}

/** Persist a browser-local intent before a paid provider POST. */
export async function savePendingBrowserRequest(snapshot) {
    if (!snapshot?.requestId) throw new Error('browser-image-recovery: browser request ID is required');
    return enqueueWrite(async () => {
        const records = await readRecords();
        const other = records.filter(item => item?.kind !== BROWSER_KIND);
        const pending = records
            .filter(item => item?.kind === BROWSER_KIND && item.id !== snapshot.requestId)
            .filter(isRetainedPending);
        const item = {
            id: snapshot.requestId,
            requestId: snapshot.requestId,
            kind: BROWSER_KIND,
            ...cloneFreeze(snapshot),
            status: 'notStarted',
            createdAt: new Date().toISOString(),
            error: null,
        };
        pending.push(item);
        const next = [...other, ...pending.slice(-MAX_PENDING_BROWSER_REQUESTS)];
        await persistRecords(next);
        emitPendingChanged();
        return item;
    });
}

/** Browser records never trigger a provider resend; callers may only update/review/discard them. */
export async function updatePendingBrowserRequest(requestId, patch = {}) {
    return enqueueWrite(async () => {
        const records = await readRecords();
        const index = records.findIndex(item => item?.kind === BROWSER_KIND && item.id === requestId);
        if (index === -1) return null;
        const item = clone(records[index]);
        for (const key of ['status', 'error', 'cardId', 'imagePath']) {
            if (Object.hasOwn(patch, key)) item[key] = patch[key];
        }
        // A preflight rejection never reached the provider, and a ready result
        // is already represented by the gallery. Neither needs recovery storage.
        const nextRecords = item.status === 'ready' || item.status === 'rejectedBeforeDispatch'
            ? records.filter((_, itemIndex) => itemIndex !== index)
            : records.map((record, itemIndex) => itemIndex === index ? item : record);
        const next = retainPendingRecords(nextRecords);
        await persistRecords(next);
        emitPendingChanged();
        return cloneFreeze(item);
    });
}

/** List browser-owned pending intents for manual review. This never resubmits requests. */
export async function listPendingBrowserRequests() {
    return (await list()).filter(isRetainedPending).slice(-MAX_PENDING_BROWSER_REQUESTS);
}

/**
 * Классификация исхода dispatch-ошибки (решение 2026-10-02: в бейдж INFO
 * попадает только фактический результат, никаких промежуточных статусов).
 *
 * true — исход ИЗВЕСТЕН, страховочная запись закрывается и карточка в INFO
 * не рождается: отмену инициировал сам пользователь (signal aborted /
 * AbortError), а ответ провайдера (httpStatus) уже виден красной строкой в
 * QUEUE и в пуле событий; технический след остаётся в dispatch-error журнале.
 *
 * false — честное «неизвестно» (таймаут, обрыв сети): POST мог уйти к
 * провайдеру, запись остаётся на разбор. Записи живой генерации из бейджа
 * вырезает reviewableRecovery в window.js.
 * @param {Error} error
 * @param {{aborted?: boolean}|null} [signal]
 * @returns {boolean}
 */
export function dispatchErrorKnown(error, signal = null) {
    if (signal?.aborted) return true;
    if (error?.name === 'AbortError') return true;
    if (Number.isSafeInteger(error?.httpStatus)) return true;
    return false;
}

/** Read one browser-owned pending intent for manual review. */
export async function getPendingBrowserRequest(requestId) {
    return (await list()).find(item => isRetainedPending(item) && item.id === requestId) || null;
}

/** Read the non-sensitive review status for one browser-owned pending intent. */
export async function getPendingBrowserRequestStatus(requestId) {
    const item = await getPendingBrowserRequest(requestId);
    return item ? Object.freeze({
        id: item.id,
        requestId: item.requestId,
        status: item.status,
        error: item.error || null,
    }) : null;
}

/** Remove expired, rejected, ready, and over-limit browser records. */
export async function prunePendingBrowserRequests() {
    return enqueueWrite(async () => {
        const records = await readRecords();
        const next = retainPendingRecords(records);
        const removed = records.length - next.length;
        if (removed === 0) return 0;
        await persistRecords(next);
        emitPendingChanged();
        return removed;
    });
}

/** Explicitly discard every browser-owned pending/recovery record. */
export async function clearPendingBrowserRequests() {
    return enqueueWrite(async () => {
        const records = await readRecords();
        const next = records.filter(item => item?.kind !== BROWSER_KIND);
        const removed = records.length - next.length;
        if (removed === 0) return 0;
        await persistRecords(next);
        emitPendingChanged();
        return removed;
    });
}

/** Explicitly discard a browser-owned pending intent. No provider request is made. */
export async function discardPendingBrowserRequest(requestId) {
    return enqueueWrite(async () => {
        const records = await readRecords();
        const next = records.filter(item => item?.kind !== BROWSER_KIND || item.id !== requestId);
        if (next.length === records.length) return false;
        await persistRecords(next);
        emitPendingChanged();
        return true;
    });
}
