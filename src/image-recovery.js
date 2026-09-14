// @ts-check
/**
 * Recovery for server-owned image requests and their durable ready results.
 *
 * A server request is persisted before submission. Once the server reports a
 * ready result, the result remains attached to that request until it has been
 * materialized in the local gallery. Startup recovery only reads server state;
 * it never runs a browser-owned provider request or downloads a provider URL.
 */
import { state, log, warn } from './core.js';
import { addToGallery, saveImageToFile } from './storage.js';
import { pushHistory } from './history.js';

// Server request recovery remains available only for records created by older
// plugin-backed releases; browser startup never loads this adapter.
async function getLegacyServerApi() {
    return import('./server-image-api.js');
}

function lf() { return SillyTavern.libs.localforage; }

const KEY = 'uris_pending_images';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SERVER_KIND = 'serverRequest';
const BROWSER_KIND = 'browserRequest';

function clone(value) {
    if (value === null || typeof value !== 'object') return value;
    return Array.isArray(value) ? value.map(clone) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
}

function cloneFreeze(value) {
    if (value === null || typeof value !== 'object') return value;
    const copy = Array.isArray(value) ? value.map(cloneFreeze) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloneFreeze(v)]));
    return Object.freeze(copy);
}

async function _list() {
    const arr = await lf().getItem(KEY);
    return Array.isArray(arr) ? arr.map(item => cloneFreeze(item)) : [];
}
async function _write(arr) { await lf().setItem(KEY, clone(arr)); }

export async function savePendingServerRequest({ requestId, connId, chatId, sourceMsgId = null, snapshot, galleryPolicy = null, galleryMetadata = null }) {
    if (!requestId || !snapshot) throw new Error('image-recovery: server request snapshot required');
    const arr = await _list();
    const index = arr.findIndex(x => x.kind === SERVER_KIND && x.id === requestId);
    const item = {
        id: requestId, requestId, kind: SERVER_KIND, connId, chatId, sourceMsgId,
        snapshot: cloneFreeze(snapshot), galleryPolicy: cloneFreeze(galleryPolicy), galleryMetadata: cloneFreeze(galleryMetadata),
        status: 'submitted', createdAt: new Date().toISOString(), attempts: 0, error: null,
    };
    if (index === -1) arr.push(item);
    else arr[index] = item;
    await _write(arr);
    return requestId;
}

export async function updatePendingServerRequest(requestId, patch = {}) {
    const arr = await _list();
    const index = arr.findIndex(x => x.kind === SERVER_KIND && x.id === requestId);
    if (index === -1) return null;
    const item = clone(arr[index]);
    const allowed = {
        status: patch.status,
        error: patch.error ?? null,
        serverState: patch.serverState ?? item.serverState,
        ...(Object.hasOwn(patch, 'result') ? { result: cloneFreeze(patch.result) } : {}),
    };
    Object.assign(item, Object.fromEntries(Object.entries(allowed).filter(([, v]) => v !== undefined)));
    arr[index] = item;
    await _write(arr);
    return item;
}

/** Persist a browser-local intent before a paid provider POST. */
export async function savePendingBrowserRequest(snapshot) {
    if (!snapshot?.requestId) throw new Error('image-recovery: browser request ID is required');
    const arr = await _list();
    const index = arr.findIndex(item => item.kind === BROWSER_KIND && item.id === snapshot.requestId);
    const item = {
        id: snapshot.requestId,
        requestId: snapshot.requestId,
        kind: BROWSER_KIND,
        ...cloneFreeze(snapshot),
        status: 'notStarted',
        createdAt: new Date().toISOString(),
        error: null,
    };
    if (index === -1) arr.push(item);
    else arr[index] = item;
    await _write(arr);
    return item;
}

/** Browser records never trigger a provider resend; callers may only update/review/discard them. */
export async function updatePendingBrowserRequest(requestId, patch = {}) {
    const arr = await _list();
    const index = arr.findIndex(item => item.kind === BROWSER_KIND && item.id === requestId);
    if (index === -1) return null;
    const item = clone(arr[index]);
    for (const key of ['status', 'error', 'cardId', 'imagePath']) {
        if (Object.hasOwn(patch, key)) item[key] = patch[key];
    }
    arr[index] = item;
    await _write(arr);
    return cloneFreeze(item);
}

function serverStateToStatus(envelope) {
    if (envelope?.state === 'ready') return 'ready';
    if (envelope?.state === 'failed-ambiguous' || envelope?.state === 'ambiguous') return 'failed-ambiguous';
    if (envelope?.state === 'failed') return 'failed';
    if (envelope?.state === 'notSubmitted' || envelope?.state === 'not-dispatched') return 'notSubmitted';
    return 'submitted';
}

async function recoverServerGet(item) {
    let envelope;
    try { envelope = await (await getLegacyServerApi()).getServerRequest(item.requestId); }
    catch (e) {
        const status = e?.code === 'REQUEST_NOT_FOUND' ? 'notSubmitted' : 'submitted';
        await updatePendingServerRequest(item.id, { status, error: e.message });
        return null;
    }
    const status = serverStateToStatus(envelope);
    await updatePendingServerRequest(item.id, {
        status,
        serverState: envelope?.state,
        error: envelope?.error?.message || null,
        ...(status === 'ready' ? { result: envelope.result } : {}),
    });
    return (await _list()).find(x => x.kind === SERVER_KIND && x.id === item.id) || null;
}

function serverResultDataUrl(item) {
    if (item?.result?.kind !== 'dataUrl' || typeof item.result.value !== 'string') {
        throw new Error('image-recovery: server ready result is not a data URL');
    }
    return item.result.value;
}

export async function materializeServerResult(requestId) {
    const item = (await _list()).find(x => x.kind === SERVER_KIND && x.id === requestId);
    if (!item || item.status !== 'ready') return null;

    const dataUrl = serverResultDataUrl(item);
    const snapshot = item.snapshot || {};
    const instruction = snapshot.instruction || {
        prompt: snapshot.prompt || '',
        aspectRatio: snapshot.aspectRatio,
        imageSize: snapshot.imageSize,
        quality: snapshot.quality,
    };
    const refs = snapshot.refs || snapshot.references || [];
    const refsSig = snapshot.refsSig || '';
    const policy = item.galleryPolicy || state.settings || {};
    let imagePath;
    try {
        imagePath = await saveImageToFile(dataUrl);
    } catch (e) {
        throw new Error(`image-recovery: native ST image upload failed: ${e.message}`);
    }

    const entry = await addToGallery(item.chatId, {
        imagePath,
        prompt: instruction.prompt,
        negativePrompt: instruction.negativePrompt,
        connectionId: snapshot.connectionId,
        routeId: snapshot.routeId,
        modelId: snapshot.modelId,
        generationContract: snapshot.generationContract,
        quality: instruction.quality ?? snapshot.quality,
        style: instruction.style,
        aspectRatio: instruction.aspectRatio,
        imageSize: instruction.imageSize,
        referenceIds: (Array.isArray(refs) ? refs : []).map(ref => ref?.id).filter(id => typeof id === 'string'),
        provenance: item.galleryMetadata || undefined,
        refsSig,
        refs: Array.isArray(refs) ? refs : [],
        sourceMsgId: item.sourceMsgId,
        saved: true,
        stGalleryPath: imagePath,
        stage2Snapshot: cloneFreeze(snapshot.stage2Snapshot ?? snapshot),
    });
    await pushHistory(item.chatId, instruction.prompt || snapshot.prompt || '');
    await _remove(item.id);
    window.dispatchEvent(new CustomEvent('uris:gallery-updated',
        { detail: { chatId: item.chatId, msgId: item.sourceMsgId } }));
    log('image-recovery: server result materialized', item.id);
    return entry;
}

export async function resumePendingServerRequests() {
    let arr = await _list();
    const now = Date.now();
    const unresolvedServerStatuses = new Set(['submitted', 'notSubmitted', 'failed', 'failed-ambiguous', 'ready']);
    arr = arr.filter(item => item.kind === SERVER_KIND && (
        now - new Date(item.createdAt).getTime() < TTL_MS || unresolvedServerStatuses.has(item.status)
    ));
    await _write(arr);
    for (const item of arr.filter(x => x.status === 'submitted')) await recoverServerGet(item);
    for (const item of (await _list()).filter(x => x.kind === SERVER_KIND && x.status === 'ready')) {
        try { await materializeServerResult(item.id); }
        catch (e) { warn('image-recovery: server result materialization failed', item.id, e.message); }
    }
}

export async function resumeServerRequest(requestId) {
    const item = (await _list()).find(x => x.kind === SERVER_KIND && x.id === requestId);
    if (!item) return null;
    if (item.status !== 'notSubmitted') {
        const recovered = await recoverServerGet(item);
        return recovered?.status === 'ready' ? materializeServerResult(requestId) : recovered;
    }
    let envelope;
    try { envelope = await (await getLegacyServerApi()).generateServerImage({ requestId: item.requestId, connectionId: item.connId, ...clone(item.snapshot) }); }
    catch (e) { await updatePendingServerRequest(requestId, { status: 'notSubmitted', error: e.message }); throw e; }
    const status = serverStateToStatus(envelope);
    await updatePendingServerRequest(requestId, {
        status,
        serverState: envelope?.state,
        error: envelope?.error?.message || null,
        ...(status === 'ready' ? { result: envelope.result } : {}),
    });
    return status === 'ready' ? materializeServerResult(requestId) : envelope;
}

export async function discardPending(id) {
    const before = await _list();
    await _write(before.filter(x => x.id !== id));
    return before.length !== (await _list()).length;
}

async function _remove(id) {
    const arr = await _list();
    await _write(arr.filter(x => x.id !== id));
}

/**
 * List unresolved server generation records for the Generation UI.
 * @returns {Promise<Array>}
 */
export async function getPendingImages() {
    const arr = await _list();
    return arr.filter(item => item.kind === SERVER_KIND
        ? item.status !== 'done'
        : item.kind === BROWSER_KIND && item.status !== 'ready');
}
