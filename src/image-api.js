// @ts-check
/** Browser-owned image generation dispatch and native gallery materialization. */
import { state } from './core.js';
import { resolveConnection } from './connections.js';
import { resolveDispatchPlan } from './dispatch-plan.js';
import { invokeImageProvider, validateImageProviderInvocation } from './image-provider-registry.js';
import { materializeImageResult, getCharacterImageFolder, makeThumbnailForPath } from './native-image-storage.js';
import { addCard, updateCard } from './gallery-index.js';
import { providerError } from './providers/image-base.js';
import { summarizeReference } from './references.js';
import { getDiagnosticSessionId, hashDiagnosticId, recordDiagnosticEvent } from './diagnostic-events.js';
import { savePendingBrowserRequest, updatePendingBrowserRequest } from './browser-image-recovery.js';

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function validateRequest(request) {
    if (!request || typeof request !== 'object') throw new TypeError('Image generation request is required');
    if (!REQUEST_ID.test(String(request.requestId || ''))) {
        throw new TypeError('Image requestId must contain 1-128 letters, numbers, underscores, or hyphens');
    }
}

function selectedRoute(connection, routeOverride = null) {
    // Explicit override: a queue/pipeline snapshot route (already synthesized
    // by dispatch-plan, or a legacy persisted route). Use it as-is so an
    // in-flight operation keeps the contract it was enqueued with.
    if (routeOverride) {
        if (routeOverride.resolutionState === 'unresolved' || !routeOverride.generationContract) {
            throw providerError('ROUTE_SELECTION_REQUIRED', 'Select and save an image route contract before generating.');
        }
        return routeOverride;
    }
    // Auto mode: synthesize the route from (endpoint shape × model family ×
    // evidence × overrides). Falls back to a persisted legacy route when the
    // record carries no model yet (records created before the v2 projection).
    const plan = resolveDispatchPlan(connection);
    if (plan) return plan.route;
    const legacy = connection?.selectedRoute;
    if (legacy && legacy.generationContract && legacy.resolutionState !== 'unresolved') return legacy;
    throw providerError('ROUTE_SELECTION_REQUIRED', 'Select a model on the image connection before generating.');
}

function pendingSnapshot(connectionId, route, request) {
    return {
        requestId: request.requestId,
        connId: connectionId,
        routeId: route.id,
        modelId: route.modelId,
        generationContract: route.generationContract,
        prompt: request.prompt || '',
        effectivePrompt: request.effectivePrompt || request.prompt || '',
        aspectRatio: request.aspectRatio || '1:1',
        imageSize: request.imageSize || '1K',
        quality: request.quality || 'auto',
        referenceIds: (request.references || []).map(ref => ref?.id).filter(id => typeof id === 'string'),
        referenceBindings: request.referenceBindings || [],
        chatId: request.chatId ?? null,
        sourceMsgId: request.sourceMsgId ?? null,
    };
}

function browserDeliveryRoute(route, conn, hasReferences = false) {
    // The connection-level `useCorsProxy` opt-in was previously scoped to
    // catalog discovery only. For providers that send no CORS headers at all
    // (CloseAI, etc.) the direct-first generation POST always dies on the
    // browser preflight and `IMAGE_DELIVERY_AMBIGUOUS` then blocks the safe
    // proxy retry - leaving the connection unusable for generation. When the
    // user has explicitly ticked "through the ST CORS proxy" AND the route is
    // JSON (multipart cannot traverse the JSON-only /proxy/), dispatch the
    // paid POST through /proxy/ on the FIRST attempt: no direct try, no
    // ambiguous state, no double-billing risk.
    //
    // This is an EXPLICIT user choice for the first attempt, not an automatic
    // post-failure fallback, so it deliberately does NOT consult the route's
    // `proxyEligible` flag (catalog.js marks all routes proxyEligible:false
    // to block the automatic direct->proxy retry path; that protection stays
    // intact for the failure-fallback branch in image-transport.js).
    // A multipart edit can never traverse the JSON-only ST /proxy/, so when the
    // request carries references AND the connection edits via multipart, the
    // dispatch must stay direct even if the user ticked the proxy box. Deciding
    // this here (rather than letting requestMultipart clear the flag later)
    // keeps the recorded delivery honest.
    const multipartEdit = hasReferences
        && route?.generationContract === 'openai-images'
        && conn?.editProtocol !== 'json';
    const useProxy = conn?.useCorsProxy === true
        && route?.transport?.bodyKind === 'json'
        && !multipartEdit;
    return {
        ...route,
        noResubmit: true,
        transport: {
            ...route.transport,
            initialDelivery: useProxy ? 'proxy' : 'direct',
            allowProxyFallback: false,
            noResubmit: true,
        },
    };
}

/**
 * Dispatch one paid generation through the explicit persisted browser route.
 * No provider POST is retried after this call begins.
 */
export async function generateImageRequest(imageConnId, request, onStatus, signal, opts = {}) {
    if (!imageConnId) throw new Error('Image connection is not selected');
    validateRequest(request);
    const resolved = await resolveConnection(imageConnId);
    if (!resolved) throw new Error('Image connection was not found');
    const { conn, apiKey } = resolved;
    const route = selectedRoute(conn, opts.route);
    const deliveryRoute = browserDeliveryRoute(route, conn, (request.references || []).length > 0);
    // Stamp the delivery the dispatcher ACTUALLY uses so the capability log
    // line can report it. The observer receives the pre-dispatch route, whose
    // transport knows nothing about the connection-level useCorsProxy
    // override, and would print 'direct' while the POST goes 'via proxy'.
    request.delivery = deliveryRoute.transport.initialDelivery;
    if (!apiKey) {
        if (route?.generationContract === 'pollinations-images') {
            throw providerError('POLLINATIONS_TOKEN_REQUIRED', 'Pollinations requires an sk_ access token in the connection Key field.');
        }
        if (route?.generationContract === 'naistera') {
            throw providerError('NAISTERA_TOKEN_REQUIRED', 'Naistera requires a token from the Telegram bot in the connection Key field.');
        }
        throw providerError('MISSING_API_KEY', 'An API key is required in this browser for the selected image connection.');
    }

    const snapshot = pendingSnapshot(imageConnId, route, request);
    const referenceSummaries = (request.references || []).map((ref, index) => ({
        index,
        id: ref?.id || null,
        name: ref?.name || null,
        mime: summarizeReference(ref).mime,
        bytes: summarizeReference(ref).kb * 1024,
        encoding: route?.generationContract === 'naistera'
            ? 'reference_objects'
            : (route?.generationContract === 'gemini-native'
                ? 'inlineData'
                : (conn.editProtocol === 'json' ? 'image_url' : 'multipart:image')),
        materialization: ref?.dataUrl ? 'ready' : 'missing',
    }));
    const diagnostic = {
        sessionId: getDiagnosticSessionId(),
        requestId: request.requestId,
        chatHash: hashDiagnosticId(request.chatId),
        msgId: request.sourceMsgId ?? null,
        connId: imageConnId,
        routeId: route.id,
        modelId: route.modelId,
        generationContract: route.generationContract,
        contractVersion: route.contractVersion,
        editProtocol: conn.editProtocol || null,
        delivery: deliveryRoute.transport.initialDelivery,
        operation: (request.references || []).length ? 'edit' : 'generate',
        requested: {
            aspectRatio: snapshot.aspectRatio,
            imageSize: snapshot.imageSize,
            quality: snapshot.quality,
        },
        referenceCount: (request.references || []).length,
        expectedReferenceCount: (request.references || []).length,
        encodedReferenceCount: null,
        references: referenceSummaries,
        role: 'generation',
    };
    await savePendingBrowserRequest(snapshot);
    const invocation = {
        endpoint: conn.endpoint,
        apiKey,
        connection: conn,
        route: deliveryRoute,
        diagnostic,
        request: {
            requestId: request.requestId,
            prompt: request.effectivePrompt || snapshot.effectivePrompt || snapshot.prompt,
            effectivePrompt: request.effectivePrompt || snapshot.effectivePrompt || snapshot.prompt,
            referenceBindings: request.referenceBindings || [],
            aspectRatio: snapshot.aspectRatio,
            imageSize: snapshot.imageSize,
            quality: snapshot.quality,
            references: request.references || [],
        },
        signal,
    };
    try {
        validateImageProviderInvocation(invocation);
    } catch (error) {
        await updatePendingBrowserRequest(request.requestId, { status: 'rejectedBeforeDispatch', error: error?.message || String(error) });
        throw error;
    }
    await updatePendingBrowserRequest(request.requestId, { status: 'dispatchingUnknown', error: null });
    onStatus?.('Generating image...');

    let result;
    try {
        result = await invokeImageProvider(invocation);
    } catch (error) {
        // A POST may have reached the provider. Keep this local record for explicit
        // user review/discard; never resume it automatically.
        await updatePendingBrowserRequest(request.requestId, { status: 'dispatchingUnknown', error: error?.message || String(error) });
        throw error;
    } finally {
        // The provider stamps what actually went on the wire onto its invocation
        // request (image-openai.js sets editDialect for every edit, and the
        // multipart→JSON proxy fallback additionally switches delivery to
        // 'proxy'). Mirror those stamps onto the caller-visible request so the
        // capability observer logs the real attempt (edit-json / proxy) instead
        // of the pre-dispatch plan (edit-multipart / direct).
        if (invocation.request?.editDialect !== undefined) request.editDialect = invocation.request.editDialect;
        if (invocation.request?.delivery) request.delivery = invocation.request.delivery;
    }

    await updatePendingBrowserRequest(request.requestId, { status: 'resultReceived', error: null });
    // Provider parameter warnings (dropped size/quality, unmapped aspect ratio)
    // reach the UI as a toast; journal them too so a dump answers "why did the
    // output not match the selection?" without a live session.
    if (Array.isArray(result?.warnings) && result.warnings.length) {
        recordDiagnosticEvent({
            event: 'provider-warnings', stage: 'stage2', requestId: request.requestId,
            connId: imageConnId, routeId: route.id, modelId: route.modelId,
            details: { warnings: result.warnings },
        });
    }
    try {
        const characterFolder = getCharacterImageFolder();
        recordDiagnosticEvent({ event: 'materialize-start', stage: 'stage2', requestId: request.requestId, connId: imageConnId, routeId: route.id, modelId: route.modelId, details: { resultKind: result?.kind || typeof result } });
        const materialized = await materializeImageResult(result, {
            filename: `uris_${request.requestId}`,
            ch_name: characterFolder,
            signal: signal,
            timeoutMs: conn.timeoutMs,
            withMetadata: true,
            diagnostic,
        });
        const imagePath = materialized.imagePath;
        // width/height come from blobMetadata (createImageBitmap decode) and may
        // be null when decoding is unavailable; aspect is derived for quick
        // comparison against the requested aspectRatio in the same dump.
        const outputMeta = materialized.output || {};
        const outWidth = Number.isFinite(outputMeta.width) ? outputMeta.width : null;
        const outHeight = Number.isFinite(outputMeta.height) ? outputMeta.height : null;
        const outputAspect = outWidth && outHeight
            ? (() => {
                const gcd = (a, b) => b ? gcd(b, a % b) : a;
                const divisor = gcd(outWidth, outHeight) || 1;
                return `${outWidth / divisor}:${outHeight / divisor}`;
            })()
            : null;
        recordDiagnosticEvent({ event: 'materialize-result', stage: 'stage2', requestId: request.requestId, outcome: 'uploaded', details: { imagePathClass: typeof imagePath === 'string' ? imagePath.split('/').slice(0, 2).join('/') : null, bytes: outputMeta.bytes ?? null, mimeType: outputMeta.mimeType ?? null, width: outWidth, height: outHeight, aspectRatio: outputAspect, requestedAspectRatio: snapshot.aspectRatio } });
        const galleryEntry = await addCard({
            imagePath,
            // Top-level natural dimensions (image-dimensions.js consumes these);
            // provenance.output keeps a sanitized copy for diagnostics only.
            ...(outWidth && outHeight ? { width: outWidth, height: outHeight } : {}),
            prompt: snapshot.prompt,
            connectionId: imageConnId,
            routeId: route.id,
            modelId: route.modelId,
            generationContract: route.generationContract,
            aspectRatio: snapshot.aspectRatio,
            imageSize: snapshot.imageSize,
            quality: snapshot.quality,
            referenceIds: snapshot.referenceIds,
            provenance: { chatId: snapshot.chatId, sourceMsgId: snapshot.sourceMsgId, characterFolder, requestId: snapshot.requestId, route: diagnostic, output: materialized.output },
            sourceMsgId: snapshot.sourceMsgId,
            status: 'ready',
        });
        await updatePendingBrowserRequest(request.requestId, { status: 'ready', error: null, cardId: galleryEntry.id, imagePath });
        recordDiagnosticEvent({ event: 'gallery-write', stage: 'stage2', requestId: request.requestId, outcome: 'ready', details: { galleryId: galleryEntry.id } });
        // Grid thumbnail, best-effort and fire-and-forget: a failure leaves the
        // card rendering the full image (the grid falls back), it never blocks
        // or fails the paid generation result.
        makeThumbnailForPath(imagePath, { filename: `uris_${request.requestId}` })
            .then(thumbPath => updateCard(galleryEntry.id, { thumbPath }))
            .catch(thumbError => recordDiagnosticEvent({
                event: 'thumbnail-error', stage: 'stage2', requestId: request.requestId,
                outcome: 'error', details: { message: thumbError?.message || String(thumbError) },
            }));
        return { ...result, galleryEntry };
    } catch (error) {
        recordDiagnosticEvent({ event: 'materialize-error', level: 'error', stage: 'stage2', requestId: request.requestId, outcome: 'error', details: { errorName: error?.name || null, errorCode: error?.code || null } });
        await updatePendingBrowserRequest(request.requestId, { status: 'resultReceived', error: error?.message || String(error) });
        throw error;
    }
}

export async function generateImage(imageConnId, instruction, refs, onStatus, signal) {
    return generateImageRequest(imageConnId, {
        requestId: instruction.requestId,
        prompt: instruction.prompt || '',
        aspectRatio: instruction.aspectRatio || '1:1',
        imageSize: instruction.imageSize || '1K',
        quality: instruction.quality || 'auto',
        references: (refs || []).map(ref => ({
            id: ref.id || '', name: ref.name || '', dataUrl: ref.image,
        })),
    }, onStatus, signal);
}
