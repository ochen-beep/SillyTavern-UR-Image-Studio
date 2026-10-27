// @ts-check
/**
 * Оркестрация инлайн-задач. Чистые функции (planScan, buildJobPlan) покрыты
 * тестами; платные вызовы (generateImageRequest, store, DOM) — в processJob.
 *
 * Словарь действий planScan (только решения о платной постановке):
 *   skip-unknown   — тип маркера вне knownTypes: диагностика, ничего не ставим
 *   store-pending  — новый маркер: сохранить pending-item до старта генерации
 *   queue          — поставить платную генерацию в очередь (auto-режим, в cap)
 *   (ничего)       — item по ключу уже есть (ready/pending/error), описание
 *                    изменилось (changed), ручной режим или cap: повторная
 *                    платная постановка не нужна. ОТОБРАЖЕНИЕ всех этих
 *                    состояний — computeShellPlan в render.js: только у DOM-
 *                    слоя есть живые requestId и grace-окно, поэтому рендер-
 *                    статусы там и живут (раньше planScan вычислял render-*,
 *                    которые сканер выбрасывал, а рендер выводил то же самое
 *                    с меньшей информацией — осиротевшие pending крутили
 *                    спиннер вечно).
 *
 * msgId/messageHash — контракт вызова: их читает сканер (upsert слота), не planScan.
 *
 * Сериализация генераций — автолейн (queueInlineJob → enqueueAutoLane), общий
 * с мостом. Контроллер регистрируется в state.activeGenerations, поэтому
 * Stop таверны накрывает и инлайн; requestId `inl_<uuid>` — тот же неймспейс
 * наблюдаемости, что у мостовых `ext_*`.
 */
import { state, getCtx, fnv1aHex } from '../core.js';
import { randomToken } from '../random.js';
import { resolveChatConfigSnapshot, buildCandidates } from '../pipeline-config.js';
import { resolvePromptReferenceContext } from '../scene-context.js';
import { imageToDataUrl } from '../references.js';
import { composeReferencePrompt } from '../reference-binding.js';
import { generateImageRequest } from '../image-api.js';
import { recordDiagnosticEvent } from '../diagnostic-events.js';
import { enqueueAutoLane } from '../autolane.js';
import { itemKey, getSlot, upsertItem } from './store.js';
import { sanitizeTriggerList, buildAliasIndex, resolveProfile, buildInlinePrompt } from './triggers.js';
import { noteQueued, noteRunning, noteFinished, postLabel } from '../ui/queue-log.js';

/** Окно «генерация ещё возможно стартует» для pending без живого requestId, мс.
 * Общее с render.js: computeShellPlan переводит осиротевший pending в error. */
export const DEFAULT_GRACE = 120_000;

/**
 * FNV-1a 32-bit hex — дедуп desc, не криптография. Реализация — общее ядро
 * core.fnv1aHex (ZOLOTOE значение стабильно: 'img|d' → '6998fd64', тест в
 * tests/inline-runner.test.js).
 * @param {string} str
 * @returns {string}
 */
export function stableHash(str) {
    return fnv1aHex(str || '');
}

/**
 * Решение по одному сообщению. Чистая: время и живые requestId внедряются.
 * @param {{
 *   msgId:number|string,
 *   messageHash:string,
 *   markers:Array,
 *   stored:{messageHash:string|null, items:Array},
 *   auto:boolean,
 *   hashFn?:(s:string) => string,
 *   cap?:number,
 *   knownTypes?:Set<string>|null
 * }} input
 * @returns {Array<{action:string, marker:object, item:object|null}>}
 */
export function planScan({ msgId, messageHash, markers, stored, auto, hashFn = stableHash, cap = 3, knownTypes = null }) {
    const actions = [];
    const items = stored.items || [];
    markers.forEach((marker, idx) => {
        if (knownTypes && !knownTypes.has(marker.type)) { actions.push({ action: 'skip-unknown', marker, item: null }); return; }
        const descHash = hashFn(`${marker.type}|${marker.desc}`);
        // Lookup РАНЬШЕ cap: существующий item (готовый результат, ошибка или
        // живая генерация) блокирует повторную платную постановку; его статус
        // — забота computeShellPlan в render.js.
        if (items.some(i => itemKey(i) === itemKey({ idx, type: marker.type, descHash }))) return;
        // Тот же слот с другим описанием (changed): перерисовка только вручную —
        // автогенерация за правку слова платила бы дважды.
        if (items.some(i => `${i.idx}|${i.type}` === `${idx}|${marker.type}`)) return;
        // НОВАЯ платная генерация — только здесь действуют cap и ручной режим.
        if (idx >= cap || !auto) return;
        const pendingItem = { idx, type: marker.type, descHash, status: 'pending', imagePath: null, cardId: null, requestId: null, error: null, createdAt: Date.now() };
        actions.push({ action: 'store-pending', marker, item: pendingItem });
        actions.push({ action: 'queue', marker, item: pendingItem });
    });
    return actions;
}

/** Чистое: собрать план задачи (промпт/аспект/политика рефов). */
export function buildJobPlan({ trigger, desc, macros = {} }) {
    const prompt = buildInlinePrompt(trigger, desc, macros);
    return {
        prompt,
        aspect: trigger.aspect || '1:1',
        refs: trigger.refsPolicy === 'off' ? null : 'auto',
    };
}

/** `inl_<uuid>` — тот же неймспейс наблюдаемости, что у мостовых `ext_*`. */
function newInlineRequestId() {
    const uuid = globalThis.crypto?.randomUUID?.() || randomToken(10);
    return `inl_${uuid}`;
}

function emitInline(type, detail) {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    try { window.dispatchEvent(new CustomEvent(type, { detail })); } catch { /* рендер не должен падать из-за события */ }
}

/**
 * Платная задача инлайна. Сериализация — автолейн (queueInlineJob);
 * контроллер регистрируется в state.activeGenerations (Stop таверны накрывает),
 * requestId `inl_<uuid>` — тот же неймспейс, что у мостовых `ext_*`.
 */
const liveJobs = new Map();

/**
 * Отмена инлайн-задач. Без аргумента — все (CHAT_CHANGED, выгрузка
 * расширения); с msgId — только задачи этого сообщения: свайп/правка одного
 * поста не должна убивать уже оплаченные генерации соседних.
 */
export function cancelInlineJobs(matchMsgId = null) {
    for (const operation of liveJobs.values()) {
        if (matchMsgId != null && Number(operation.msgId) !== Number(matchMsgId)) continue;
        operation.controller.abort();
    }
}

function sourceCurrent(operation, msgId) {
    const ctx = getCtx();
    return ctx.chatId === operation.chatId && ctx.chatMetadata === operation.metadata
        && (msgId < 0 || (ctx.chat?.[msgId] === operation.message && operation.message?.mes === operation.text));
}

function captureOperation(job) {
    const ctx = getCtx();
    const requestId = newInlineRequestId();
    const controller = new AbortController();
    const message = ctx.chat?.[job.msgId];
    const operation = { requestId, controller, msgId: job.msgId, chatId: ctx.chatId,
        metadata: ctx.chatMetadata, message, text: message?.mes };
    state.activeGenerations.set(requestId, controller);
    liveJobs.set(requestId, operation);
    return operation;
}

export async function processJob({ msgId, idx, type, desc }, operation = null) {
    operation ||= captureOperation({ msgId, idx, type, desc });
    const { requestId, controller } = operation;
    const check = () => {
        if (controller.signal.aborted || !sourceCurrent(operation, msgId)) {
            controller.abort();
            throw Object.assign(new Error('Inline source changed or request cancelled'), { code: 'ABORTED' });
        }
    };
    state.activeGenerations.set(requestId, controller);
    const startedAt = Date.now();
    recordDiagnosticEvent({ event: 'inline-start', requestId, details: { msgId, idx, type } });
    // Журнал очереди пишет продюсер (один писатель; окно — только читатель).
    // noteQueued идемпотентен по id: прямой processJob без queued-события
    // всё равно попадёт в ленту, а задвоения не будет.
    noteQueued({ id: requestId, label: postLabel(msgId, 'Инлайн'), lane: 'auto' });
    noteRunning(requestId);
    emitInline('uris:inline-start', { requestId, msgId });
    const descHash = stableHash(`${type}|${desc}`);
    // Живой pending сразу: сохранённый requestId — единственный способ для
    // planScan отличить работающую генерацию от осиротевшей. Без него задача,
    // стоящая за длинным мостовым POST, флипается в render-error с платным
    // retry, пока ещё выполняется. Store не даёт готовому ready откатиться
    // в pending (его guard ready→pending), а keyword-задачи получают видимый
    // живой pending ещё до первого скана.
    if (msgId >= 0 && sourceCurrent(operation, msgId)) upsertItem(msgId, { idx, type, descHash, desc, status: 'pending', requestId, createdAt: Date.now() });
    let outcome = 'error';      // 'ready' | 'cancelled' | 'error'
    let errorCode = null;
    let errorText = null;       // человекочитаемая причина для UI (item.error, uris:inline-end)
    let imagePath = null;
    let cardId = null;
    try {
        check();
        // Неизвестный триггер (АМЕНД 1, ревью Task 6): pending не должен
        // повиснуть — catch ниже конвертирует его в error-item с кодом.
        const trigger = resolveProfile(buildAliasIndex(sanitizeTriggerList(state.settings?.inlineTriggers || [])), type);
        if (!trigger) throw Object.assign(new Error(`Unknown inline trigger "${type}"`), { code: 'TRIGGER_NOT_FOUND' });
        const macroFallback = (() => {
            try {
                const ctx = getCtx();
                return { charName: ctx?.characters?.[ctx.characterId]?.name, userName: ctx?.name1 };
            } catch { return {}; }
        })();
        const plan = buildJobPlan({ trigger, desc, macros: macroFallback });

        const snapshot = await resolveChatConfigSnapshot();
        check();
        const connId = snapshot.imageProfileId;
        if (!connId) throw Object.assign(new Error('No image connection'), { code: 'NO_CONNECTION' });

        // Референсы по политике профиля (зеркало bridge.generateOnce): pool-id
        // у инлайна нет — только авто-резолвер сцены. Description-рефы
        // КОМПОЗИРУЮТСЯ в промпт: провайдеры читают позиционные bindings
        // ({index,label,description}) против references, сырой {name,description}
        // им не подходит.
        const references = [];
        const descriptionEntries = [];
        if (plan.refs === 'auto') {
            const candidates = await buildCandidates(state.currentChatId || 'current');
            const resolution = await resolvePromptReferenceContext({
                prompt: plan.prompt, candidates,
                corrections: { includedIds: [], excludedIds: [], revision: 0 },
            });
            for (const r of resolution.stage2Refs || []) {
                if (r.bindingMode === 'description') {
                    descriptionEntries.push({ id: r.id, name: r.name, description: r.description, bindingMode: 'description' });
                    continue;
                }
                check();
                const dataUrl = await imageToDataUrl(r.imagePath, { signal: controller.signal });
                check();
                if (dataUrl && !references.some(x => x.id === r.id)) references.push({ id: r.id, name: r.name, dataUrl });
            }
        }
        let referenceBindings = [];
        let prompt = plan.prompt;
        if (descriptionEntries.length) {
            const composed = composeReferencePrompt(prompt, descriptionEntries);
            prompt = composed.effectivePrompt;
            referenceBindings = composed.bindings;
        }

        check();
        const result = await generateImageRequest(connId, {
            requestId,
            prompt,
            // Галерейная карточка берёт snapshot.effectivePrompt — он должен
            // показывать итоговый промпт (шелл + описание), а не голое описание.
            effectivePrompt: prompt,
            aspectRatio: plan.aspect,
            references,
            referenceBindings,
            chatId: operation.chatId ?? null,
            sourceMsgId: msgId,
        }, () => {}, controller.signal, { route: snapshot.imageRoute });

        const entry = result?.galleryEntry || {};
        imagePath = entry.imagePath ?? null;
        cardId = entry.id ?? null;
        if (msgId >= 0 && sourceCurrent(operation, msgId)) upsertItem(msgId, { idx, type, descHash, desc, status: 'ready', imagePath, cardId, requestId, error: null, createdAt: Date.now() });
        outcome = 'ready';
        return { requestId, imagePath, cardId };
    } catch (e) {
        const cancelled = controller.signal.aborted || e?.name === 'AbortError';
        outcome = cancelled ? 'cancelled' : 'error';
        errorCode = cancelled ? 'aborted' : String(e?.code || e?.message || e);
        // UI показывает сообщение ('No image connection'), сырой код
        // ('NO_CONNECTION') остаётся в диагностическом событии ниже.
        errorText = cancelled ? 'Генерация отменена' : String(e?.message || e);
        // Провал реролла не откатывает платный ready-результат в ошибку: старая
        // картинка остаётся видимой, провал уходит вызывающему (реролл/retry, Task 8).
        const canWrite = msgId >= 0 && sourceCurrent(operation, msgId);
        const wasReady = canWrite && getSlot(msgId).items.some(i => i.status === 'ready' && itemKey(i) === itemKey({ idx, type, descHash }));
        if (canWrite && !wasReady) {
            upsertItem(msgId, { idx, type, descHash, desc, status: 'error', imagePath: null, cardId: null, requestId, error: errorText, createdAt: Date.now() });
        }
        // DOMException AbortError carries a legacy numeric .code (20): wrap by string-code check.
        if (cancelled && typeof e?.code !== 'string') throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
        throw e;
    } finally {
        state.activeGenerations.delete(requestId);
        liveJobs.delete(requestId);
        // Ровно один end-сигнал на задачу, включая провал/отмену — иначе рендер
        // крутит спиннер до чужого события.
        recordDiagnosticEvent({ event: 'inline-end', requestId, outcome,
            durationMs: Date.now() - startedAt,
            details: { msgId, type, code: outcome === 'ready' ? null : errorCode, cardId } });
        // Закрыть строку журнала исходом (один писатель — продюсер).
        noteFinished(requestId, outcome === 'ready' ? 'success' : outcome, outcome === 'ready' ? '' : errorText);
        emitInline('uris:inline-end', { requestId, msgId, idx, type, outcome, imagePath, error: outcome === 'ready' ? null : errorText });
    }
}

/** Задача через автолейн (сериально с мостом). */
export function queueInlineJob(job) {
    const operation = captureOperation(job);
    if (job.msgId >= 0) upsertItem(job.msgId, { idx: job.idx, type: job.type,
        descHash: stableHash(`${job.type}|${job.desc}`), status: 'pending',
        requestId: operation.requestId, createdAt: Date.now() });
    // Журнал очереди (бейдж QUEUE): строка рождается «ждёт» ещё в автолейне и
    // переходит в «выполняется» только когда processJob реально стартует.
    // Пишет продюсер (один писатель; окно — только читатель).
    noteQueued({ id: operation.requestId, label: postLabel(job.msgId, 'Инлайн'), lane: 'auto' });
    emitInline('uris:inline-queued', { requestId: operation.requestId, msgId: job.msgId });
    return enqueueAutoLane(() => processJob(job, operation));
}

/** Ручной перезапуск (реролл/retry): старая картинка остаётся в галерее. */
export function rerollInline(job) { return queueInlineJob(job); }
