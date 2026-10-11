// @ts-check
/** Browser-owned image generation dispatch and native gallery materialization. */
import { state, fetchWithTimeout } from './core.js';
import { resolveConnection } from './connections.js';
import { resolveDispatchPlan } from './dispatch-plan.js';
import { invokeImageProvider, validateImageProviderInvocation } from './image-provider-registry.js';
import { serialize } from './serialize.js';
import { isCorsProxyAvailable, isCorsOrNetworkError } from './proxy.js';
import { deliveryHintFor, noteProbe } from './delivery-evidence.js';
import { materializeImageResult, getCharacterImageFolder, makeThumbnailForPath } from './native-image-storage.js';
import { addCard, updateCard } from './gallery-index.js';
import { providerError, assertApiKeyForContract } from './providers/image-base.js';
import { summarizeReference } from './references.js';
import { aspectDeviates } from './aspect-ratio.js';
import { resolutionShortfall } from './image-dimensions.js';
import { getDiagnosticSessionId, hashDiagnosticId, recordDiagnosticEvent, flushDiagnosticEvents } from './diagnostic-events.js';
import { savePendingBrowserRequest, updatePendingBrowserRequest, discardPendingBrowserRequest, dispatchErrorKnown } from './browser-image-recovery.js';

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
    // JSON-маршруты диспетчатся по лестнице ниже; multipart-редактирование
    // (openai-images + референсы + multipart-пин) не может идти через
    // JSON-only /proxy/ — оно всегда напрямую, даже при «Через прокси».
    // Решение принимается здесь, чтобы записанная доставка была честной.
    const multipartEdit = hasReferences
        && route?.generationContract === 'openai-images'
        && conn?.editProtocol !== 'json';
    // Delivery policy for the paid POST. «Авто» is encoded by the ABSENCE of
    // overrides.delivery (normalizeConnectionOverrides drops 'auto').
    const policy = conn?.overrides?.delivery === 'proxy' || conn?.overrides?.delivery === 'direct'
        ? conn.overrides.delivery
        : '';
    // «Авто» ladder (2026-09-28, единый источник — пункт 2.1 плана 2026-10-05):
    // только delivery-evidence (опыт платных POST + вердикт пробы). A fresh
    // direct success outranks a stale probe verdict so «Авто» self-heals back
    // to direct; a fresh ambiguous failure outranks everything short of an
    // explicit order. detected.delivery больше не читается диспетчем — он
    // остаётся только отображением на карточке. A known-disabled ST proxy
    // keeps «Авто» on direct — a guaranteed proxy error helps nobody, and the
    // ambiguous error at least matches what the user would see without the
    // learning layer.
    const hint = deliveryHintFor(conn);
    const autoWantsProxy = hint === 'proxy' && isCorsProxyAvailable() !== false;
    const useProxy = (policy === 'proxy' || (policy === '' && autoWantsProxy))
        && route?.transport?.bodyKind === 'json'
        && !multipartEdit;
    return {
        ...route,
        transport: {
            ...route.transport,
            initialDelivery: useProxy ? 'proxy' : 'direct',
            // Who chose this path: an explicit user order or the «Авто» ladder.
            // Only 'auto' makes the transport's preflight oracle (safe proxy
            // rescue) eligible; explicit orders are never second-guessed.
            deliveryPolicy: policy === 'proxy' ? 'explicit-proxy' : policy === 'direct' ? 'explicit-direct' : 'auto',
        },
    };
}

// Контракты, чьи GET-каталоги говорят о доставке POST: у pollinations/naistera
// своя форма каталога, разведка не нужна (их прямая доставка исторически жива).
const DELIVERY_PROBE_CONTRACTS = new Set(['openai-images', 'chat-completions', 'openrouter-images']);

/**
 * Дешёвая разведка доставки до первого платного POST (перенос паттерна
 * providers/openai.js на картинный путь, 2026-09-28): один GET /models с теми
 * же заголовками. Читаемый ответ → вердикт пробы 'direct'; CORS/сетевой
 * TypeError → 'proxy' — лестница «Авто» сразу поведёт POST через прокси.
 * Пункт 2.1: проба пишет в единый delivery-evidence (noteProbe) — тот же
 * факт, что пишет «Проверить», а не в отдельную память. Запускается только
 * когда знаний нет вовсе: ни факта пробы, ни опыта POST (deliveryHintFor
 * теперь покрывает оба). Best-effort: неудача разведки (кроме отмены) не
 * блокирует генерацию.
 */
async function probeDeliveryBeforeFirstPost(conn, apiKey, route, signal) {
    try {
        if (!DELIVERY_PROBE_CONTRACTS.has(route?.generationContract)) return;
        if (conn?.detected?.checkedAt || deliveryHintFor(conn)) return;
        const base = String(conn?.endpoint || '').trim().replace(/\/+$/, '');
        if (!base) return;
        await fetchWithTimeout(`${base}/models`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey}` },
            ...(signal ? { signal } : {}),
        }, 15000);
        noteProbe({ connId: conn.id, endpoint: conn.endpoint, verdict: 'direct' }).catch(() => {});
    } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') return;
        if (isCorsOrNetworkError(error)) {
            noteProbe({ connId: conn.id, endpoint: conn.endpoint, verdict: 'proxy' }).catch(() => {});
        }
    }
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
    // Пункт 2.3: наличие ключа — по дескриптору контракта (те же типизированные
    // ошибки, что и в requireInvocation; ComfyUI — ключ опционален).
    assertApiKeyForContract(route?.generationContract, apiKey);

    const snapshot = pendingSnapshot(imageConnId, route, request);
    const referenceSummaries = (request.references || []).map((ref, index) => ({
        index,
        id: ref?.id || null,
        name: ref?.name || null,
        mime: summarizeReference(ref).mime,
        bytes: summarizeReference(ref).kb * 1024,
        encoding: route?.generationContract === 'comfyui'
            ? 'upload/image (LoadImage)'
            : route?.generationContract === 'naistera'
                ? 'reference_objects'
                : (route?.generationContract === 'gemini-native' || route?.generationContract === 'gemini-interactions'
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
    // Разведка доставки: непроверенный коннект не должен учиться на гиблом
    // платном POST, если это можно выяснить бесплатным GET-ом. После валидации,
    // чтобы невалидные запросы не зондировали сеть.
    await probeDeliveryBeforeFirstPost(conn, apiKey, route, signal).catch(() => {});
    onStatus?.('Generating image...');

    let result;
    try {
        // Глобальный семафор на провайдера: очередь, inline и мост сериализуют
        // каждый сам по себе и не делят общий мьютекс — без этого guard'а две
        // генерации одного коннекта из разных лейнов уходят в платный POST
        // одновременно. Ключ — коннект: разные провайдеры не блокируют друг
        // друга. Отменённый вызов получает ход и сразу выходит через AbortError
        // адаптера, не занимая слот надолго.
        // dispatchingUnknown ставится ВНУТРИ хода: стоящий в очереди запрос ещё
        // ничего не отправил, и запись «исход неизвестен» на него не заводится.
        result = await serialize(`uris-provider:${conn.id}`, async () => {
            await updatePendingBrowserRequest(request.requestId, { status: 'dispatchingUnknown', error: null });
            return invokeImageProvider(invocation);
        });
    } catch (error) {
        // В INFO — только фактический результат, никаких промежуточных
        // статусов. Известный исход (отмена пользователем, ответ провайдера с
        // httpStatus) закрывает запись: карточка «результат запроса
        // неизвестен» не рождается — отмену видно в QUEUE, ошибку видно в
        // QUEUE и пуле, технический след остаётся в dispatch-error журнале.
        // Неизвестный исход (таймаут/обрыв сети — POST мог уйти) остаётся
        // страховочной записью на разбор.
        if (dispatchErrorKnown(error, signal)) {
            await discardPendingBrowserRequest(request.requestId).catch(() => {});
        } else {
            await updatePendingBrowserRequest(request.requestId, { status: 'dispatchingUnknown', error: error?.message || String(error) });
        }
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
        // Пункт 2.2: фактическая доставка удачной ноги приходит штампом
        // __urisAttempt — обёртка транспорта в реестре ставит её на
        // invocation.request.delivery (выше). Поиск по журналу диагностики
        // удалён: журнал снова write-only.
        // Исход диспетча известен — события (включая dispatch-start, который
        // мог быть записан уже в фоновой вкладке) обязаны дойти до
        // персистенции немедленно, а не по throttle-таймеру.
        flushDiagnosticEvents();
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
        // Post-hoc truth check: the wire may have carried the requested ratio
        // (param dialect) or not (warning upstream already fired), but either
        // way the gateway/model could return a different canvas. Surface the
        // mismatch the same way as dropped parameters — this also catches
        // "parameter sent but ignored", which no pre-flight check can see.
        const aspectDeviation = aspectDeviates(outWidth, outHeight, snapshot.aspectRatio);
        if (aspectDeviation !== null) {
            const mismatchWarning = {
                feature: 'Стороны',
                details: `модель вернула ${outWidth}×${outHeight} (${outputAspect}) вместо запрошенного ${snapshot.aspectRatio} — шлюз или модель не соблюли пропорцию.`,
            };
            result.warnings = [...(Array.isArray(result?.warnings) ? result.warnings : []), mismatchWarning];
            recordDiagnosticEvent({
                event: 'aspect-mismatch', stage: 'stage2', requestId: request.requestId,
                connId: imageConnId, routeId: route.id, modelId: route.modelId,
                details: { requested: snapshot.aspectRatio, width: outWidth, height: outHeight, outputAspect, deviation: aspectDeviation },
            });
        }
        // Post-hoc truth check #2 (пункт 1.2): молчаливый даунгрейд разрешения —
        // пропорции в норме, но пикселей меньше, чем обещает запрошенный тир.
        // Если адаптер уже предупредил, что тир не поддержан и не ушёл на провод
        // (provider-warning с feature: 'Размер'), факт «параметра не было»
        // озвучен — дублировать факт «параметр проигнорирован» не нужно.
        const sizeShortfall = resolutionShortfall(outWidth, outHeight, snapshot.imageSize);
        const alreadyWarnedAboutSize = Array.isArray(result?.warnings) && result.warnings.some(item => item?.feature === 'Размер');
        if (sizeShortfall && !alreadyWarnedAboutSize) {
            result.warnings = [...(Array.isArray(result?.warnings) ? result.warnings : []), {
                feature: 'Размер',
                details: `запрошен тир ${sizeShortfall.tier}, модель вернула ${outWidth}×${outHeight} (${sizeShortfall.megapixels.toFixed(2)} МП) — меньше ожидаемого минимума ${sizeShortfall.minMegapixels} МП; разрешение уронено шлюзом или моделью.`,
            }];
            recordDiagnosticEvent({
                event: 'resolution-shortfall', stage: 'stage2', requestId: request.requestId,
                connId: imageConnId, routeId: route.id, modelId: route.modelId,
                details: { requested: snapshot.imageSize, width: outWidth, height: outHeight, megapixels: sizeShortfall.megapixels, minMegapixels: sizeShortfall.minMegapixels },
            });
        }
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
        flushDiagnosticEvents();
        // Grid thumbnail, best-effort and fire-and-forget: a failure leaves the
        // card rendering the full image (the grid falls back), it never blocks
        // or fails the paid generation result. Success is logged too — without
        // it the background pipeline is invisible next to thumbnail-error.
        const thumbnailStartedAt = Date.now();
        makeThumbnailForPath(imagePath, { filename: `uris_${request.requestId}` })
            .then(thumbPath => updateCard(galleryEntry.id, { thumbPath }))
            .then(() => recordDiagnosticEvent({
                event: 'thumbnail-done', stage: 'stage2', requestId: request.requestId,
                outcome: 'ready', durationMs: Date.now() - thumbnailStartedAt,
                details: { galleryId: galleryEntry.id },
            }))
            .catch(thumbError => recordDiagnosticEvent({
                event: 'thumbnail-error', stage: 'stage2', requestId: request.requestId,
                outcome: 'error', details: { message: thumbError?.message || String(thumbError) },
            }));
        return { ...result, galleryEntry };
    } catch (error) {
        recordDiagnosticEvent({ event: 'materialize-error', level: 'error', stage: 'stage2', requestId: request.requestId, outcome: 'error', details: { errorName: error?.name || null, errorCode: error?.code || null } });
        flushDiagnosticEvents();
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
