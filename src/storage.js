// @ts-check
/**
 * Gallery facade: shared native ST files plus the shared metadata card index.
 * localforage is read-only migration input for legacy chat entries.
 */
import { uid, log, getCtx } from './core.js';
import { recordDiagnosticEvent, hashDiagnosticId } from './diagnostic-events.js';
import { addCard, countCardsByImagePath, listCards, removeCard, updateCard } from './gallery-index.js';
import { listRefs } from './refs-library.js';
import { materializeImageResult, uploadGeneratedImage } from './native-image-storage.js';
import { canonicalizeNativeImagePath } from './native-image-path.js';

function isNativeGalleryPath(value) {
    return canonicalizeNativeImagePath(value) !== null;
}

function cardForGallery(card) {
    return { ...card, src: card.imagePath, saved: isNativeGalleryPath(card.imagePath), stGalleryPath: card.imagePath };
}

function belongsToChat(card, chatId) {
    return card?.provenance?.chatId === chatId;
}

/**
 * List this chat's shared cards; localforage is migration input only.
 * Reconcile (a server-side scan of every folder) is opt-in — it is a
 * toolbar button in the gallery, not a per-render cost (v0.9.4).
 */
export async function getGallery(chatId, { reconcile = false } = {}) {
    let cards = [];
    try { cards = await listCards({ reconcile }); }
    catch (error) { log('Native gallery unavailable:', error.message); }
    return cards
        .filter(card => belongsToChat(card, chatId) && card.hidden !== true)
        .map(cardForGallery);
}

/**
 * Persist a generation card in the shared index. Data URLs, byte results, and
 * provider URLs are materialized into the native ST gallery before metadata is saved.
 */
export async function addToGallery(chatId, entry) {
    const full = { id: entry.id || uid(), ts: Date.now(), saved: false, ...entry };
    const existing = await listCards({ reconcile: false }).then(cards => cards.find(card => card.id === full.id));
    if (existing && !belongsToChat(existing, chatId)) {
        throw new Error('Gallery card ID belongs to another chat');
    }
    let imagePath = full.imagePath || full.stGalleryPath || (isNativeGalleryPath(full.src) ? full.src : '');
    try {
        if (!imagePath && typeof full.src === 'string' && full.src) {
            const result = full.src.startsWith('data:') ? full.src : { kind: 'url', value: full.src };
            imagePath = await materializeImageResult(result, { filename: `uris_${full.id}` });
        }
        if (!imagePath && full.result) {
            imagePath = await materializeImageResult(full.result, { filename: `uris_${full.id}` });
        }
    } catch (error) {
        // Keep legacy server-recovery entries usable while native ST storage rolls out.
        // A later manual save can materialize this cached data URL.
        log('Native gallery materialization failed; retaining legacy cache:', error.message);
    }

    if (!imagePath) {
        throw new Error('Gallery image must be materialized in native storage before indexing');
    }

    const card = await addCard({
        ...full,
        imagePath,
        provenance: { ...(full.provenance || {}), chatId, sourceMsgId: full.sourceMsgId ?? null },
        status: 'ready',
    });
    const shared = cardForGallery(card);
    log('Added native gallery card', card.id);
    return shared;
}

async function isReferencedByPool(imagePath) {
    const canonical = canonicalizeNativeImagePath(imagePath);
    if (!canonical) return false;
    try {
        const refs = await listRefs();
        return refs.some(ref => canonicalizeNativeImagePath(ref.imagePath) === canonical);
    } catch (error) {
        log('Reference usage check failed; preserving native file:', error.message);
        return true;
    }
}

async function deleteNativeImageFile(imagePath) {
    const ctx = getCtx();
    try {
        const response = await fetch('/api/images/delete', {
            method: 'POST',
            headers: { ...(ctx.getRequestHeaders?.() ?? {}), 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: imagePath }),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return true;
    } catch (error) {
        log('Native image file delete failed:', error.message);
        return false;
    }
}

/**
 * Delete a gallery card. With deleteFile=false (default) the card is hidden
 * (file survives in ST Show Gallery); with deleteFile=true the card is removed
 * and the file is erased via POST /api/images/delete, unless another card still
 * references the same path (then degrade to hide to avoid breaking the other card).
 */
export async function deleteGalleryCard(chatId, id, { deleteFile = false } = {}) {
    const card = (await listCards({ reconcile: false })).find(item => item.id === id);
    if (!belongsToChat(card, chatId)) return false;
    if (deleteFile) {
        const shared = countCardsByImagePath(card.imagePath) > 1;
        const referenced = await isReferencedByPool(card.imagePath);
        if (shared || referenced) {
            await updateCard(id, { hidden: true });
            recordDiagnosticEvent({
                event: 'gallery-card-remove', stage: 'gallery', chatHash: hashDiagnosticId(chatId),
                outcome: 'hidden', details: { deleteFile: true, reason: referenced ? 'used-by-reference' : 'shared-image-path' },
            });
            log(referenced ? 'Delete file skipped: path is used by a reference; hidden instead' : 'Delete file skipped: path shared by another card; hidden instead', id);
            return true;
        }
        await removeCard(id);
        const deleted = await deleteNativeImageFile(card.imagePath);
        if (!deleted) {
            log('Gallery card removed but native file deletion was not confirmed', id);
        }
        // The thumbnail lives in its own folder and is owned by this card only;
        // best-effort — a stale thumbnail costs a little disk, nothing else.
        if (card.thumbPath) await deleteNativeImageFile(card.thumbPath);
        recordDiagnosticEvent({
            event: 'gallery-card-remove', stage: 'gallery', chatHash: hashDiagnosticId(chatId),
            outcome: 'deleted', details: { deleteFile: true, fileDeleted: deleted },
        });
        log('Deleted gallery card and file', id);
        return true;
    }
    await updateCard(id, { hidden: true });
    recordDiagnosticEvent({
        event: 'gallery-card-remove', stage: 'gallery', chatHash: hashDiagnosticId(chatId),
        outcome: 'hidden', details: { deleteFile: false },
    });
    log('Hidden gallery card', id);
    return true;
}

export async function updateGalleryEntry(chatId, id, patch) {
    const card = (await listCards({ reconcile: false })).find(item => item.id === id);
    if (!belongsToChat(card, chatId)) return null;
    const updated = await updateCard(id, patch);
    return updated ? cardForGallery(updated) : null;
}

/** Clear shared metadata cards belonging to one chat. Native source files remain untouched. */
export async function clearGallery(chatId, { deleteFiles = false } = {}) {
    const cards = await listCards({ reconcile: false });
    const mine = cards.filter(card => belongsToChat(card, chatId));
    if (deleteFiles) {
        for (const card of mine) {
            const shared = countCardsByImagePath(card.imagePath) > 1;
            const referenced = await isReferencedByPool(card.imagePath);
            if (!shared && !referenced) await deleteNativeImageFile(card.imagePath);
        }
        await Promise.all(mine.map(card => removeCard(card.id)));
    } else {
        await Promise.all(mine.map(card => updateCard(card.id, { hidden: true })));
    }
    recordDiagnosticEvent({
        event: 'gallery-clear', stage: 'gallery', chatHash: hashDiagnosticId(chatId),
        outcome: 'ok', details: { count: mine.length, deleteFiles },
    });
    log('Gallery cleared for chat', chatId, deleteFiles ? '(files deleted)' : '(cards hidden)');
}
