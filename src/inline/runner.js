// @ts-check
/**
 * Оркестрация инлайн-задач. Чистые функции (planScan, buildJobPlan) покрыты
 * тестами; платные вызовы (generateImageRequest, store, DOM) — в processJob.
 *
 * Словарь действий planScan:
 *   skip-unknown   — тип маркера вне knownTypes: диагностика, ничего не рендерим
 *   render-ready   — готовый (оплаченный) результат с файлом; перезагрузка бесплатна
 *   render-pending — генерация ещё в работе (живой requestId или в грейс-окне)
 *   render-changed — desc изменился после генерации: старая картинка + признак изменений
 *   render-error   — ошибка генерации / осиротевший pending / ready без файла → retry
 *   render-button  — ручной режим, либо cap и нужна НОВАЯ генерация
 *   store-pending  — новый маркер: сохранить pending-item до старта генерации
 *   queue          — поставить платную генерацию в очередь (auto-режим)
 *
 * msgId/messageHash — контракт вызова: их читает сканер (upsert слота), не planScan.
 *
 * Сериализация генераций — автолейн (queueInlineJob → enqueueAutoLane), общий
 * с мостом. Контроллер регистрируется в state.activeGenerations, поэтому
 * Stop таверны накрывает и инлайн; requestId `inl_<uuid>` — тот же неймспейс
 * наблюдаемости, что у мостовых `ext_*`.
 */
import { state, getCtx } from '../core.js';
import { resolveChatConfigSnapshot, buildCandidates } from '../pipeline-config.js';
import { resolvePromptReferenceContext } from '../scene-context.js';
import { imageToDataUrl } from '../references.js';
import { generateImageRequest } from '../image-api.js';
import { recordDiagnosticEvent } from '../diagnostic-events.js';
import { enqueueAutoLane } from '../autolane.js';
import { itemKey, upsertItem } from './store.js';
import { sanitizeTriggerList, buildAliasIndex, resolveProfile, buildInlinePrompt } from './triggers.js';

/** Окно «генерация ещё возможно стартует» для pending без живого requestId, мс. */
const DEFAULT_GRACE = 120_000;

/**
 * FNV-1a 32-bit, hex — дедуп desc, не криптография.
 * ЗОЛОТОЕ ЗНАЧЕНИЕ: stableHash('img|d') === '6998fd64' зафиксировано тестом —
 * смена алгоритма тихо осиротит все сохранённые descHash и перегенерирует всё.
 * @param {string} str
 * @returns {string}
 */
export function stableHash(str) {
    let h = 0x811c9dc5;
    const bytes = new TextEncoder().encode(String(str || ''));
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return (h >>> 0).toString(16);
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
 *   knownTypes?:Set<string>|null,
 *   inFlight?:Set<string>|null,
 *   now?:() => number,
 *   grace?:number
 * }} input
 * @returns {Array<{action:string, marker:object, item:object|null}>}
 */
export function planScan({ msgId, messageHash, markers, stored, auto, hashFn = stableHash, cap = 3, knownTypes = null, inFlight = null, now = Date.now, grace = DEFAULT_GRACE }) {
    const actions = [];
    const items = stored.items || [];
    markers.forEach((marker, idx) => {
        if (knownTypes && !knownTypes.has(marker.type)) { actions.push({ action: 'skip-unknown', marker, item: null }); return; }
        const descHash = hashFn(`${marker.type}|${marker.desc}`);
        const key = itemKey({ idx, type: marker.type, descHash });
        // Lookup РАНЬШЕ cap: существующий (оплаченный) результат рендерится
        // бесплатно, даже если маркер уехал за лимит после правки выше.
        const item = items.find(i => itemKey(i) === key);
        if (item && item.status === 'ready') {
            // Файл не материализовался (потерян/не сохранён) → retry, а не мёртвый рендер.
            actions.push({ action: item.imagePath ? 'render-ready' : 'render-error', marker, item });
            return;
        }
        if (item && item.status === 'error') { actions.push({ action: 'render-error', marker, item }); return; }
        if (item && item.status === 'pending') {
            // Осиротевший pending (перезагрузка/краш) не должен крутить спиннер вечно:
            // живой requestId или грейс-окно «ещё стартует», иначе — ошибка с retry.
            const live = !!(inFlight && item.requestId != null && inFlight.has(item.requestId));
            const fresh = (now() - (item.createdAt || 0)) < grace;
            actions.push({ action: live || fresh ? 'render-pending' : 'render-error', marker, item });
            return;
        }
        // item нет, либо desc изменился → changed поверх старой картинки (вне cap)
        const changed = items.some(i => `${i.idx}|${i.type}` === `${idx}|${marker.type}` && i.descHash !== descHash);
        if (changed) {
            actions.push({ action: 'render-changed', marker, item: items.find(i => `${i.idx}|${i.type}` === `${idx}|${marker.type}`) });
            return;
        }
        // Нужна НОВАЯ платная генерация — только здесь действуют cap и ручной режим.
        if (idx >= cap || !auto) { actions.push({ action: 'render-button', marker, item: null }); return; }
        const pendingItem = { idx, type: marker.type, descHash, status: 'pending', imagePath: null, cardId: null, requestId: null, error: null, createdAt: now() };
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
    const uuid = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
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
export async function processJob({ msgId, idx, type, desc }) {
    const requestId = newInlineRequestId();
    const controller = new AbortController();
    state.activeGenerations.set(requestId, controller);
    recordDiagnosticEvent({ event: 'inline-start', requestId, details: { msgId, idx, type } });
    const descHash = stableHash(`${type}|${desc}`);
    try {
        // АМЕНД 1 (ревью Task 6): неизвестный триггер между planScan и исполнением
        // не должен оставлять висящий pending — сразу error-item, потом throw.
        const trigger = resolveProfile(buildAliasIndex(sanitizeTriggerList(state.settings?.inlineTriggers || [])), type);
        if (!trigger) {
            upsertItem(msgId, { idx, type, descHash, status: 'error', imagePath: null, cardId: null, requestId, error: 'TRIGGER_NOT_FOUND', createdAt: Date.now() });
            throw Object.assign(new Error(`Unknown inline trigger "${type}"`), { code: 'TRIGGER_NOT_FOUND' });
        }
        const macroFallback = (() => {
            try {
                const ctx = getCtx();
                return { charName: ctx?.characters?.[ctx.characterId]?.name, userName: ctx?.name1 };
            } catch { return {}; }
        })();
        const plan = buildJobPlan({ trigger, desc, macros: macroFallback });

        const snapshot = await resolveChatConfigSnapshot();
        const connId = snapshot.imageProfileId;
        if (!connId) throw Object.assign(new Error('No image connection'), { code: 'NO_CONNECTION' });

        // Референсы по политике профиля (зеркало bridge.generateOnce)
        let references = [];
        let referenceBindings = [];
        if (plan.refs === 'auto') {
            const candidates = await buildCandidates(state.currentChatId || 'current');
            const resolution = await resolvePromptReferenceContext({
                prompt: plan.prompt, candidates,
                corrections: { includedIds: [], excludedIds: [], revision: 0 },
            });
            for (const r of resolution.stage2Refs || []) {
                if (r.bindingMode === 'description') {
                    referenceBindings.push({ name: r.name, description: r.description, bindingMode: 'description' });
                    continue;
                }
                const dataUrl = await imageToDataUrl(r.imagePath);
                if (dataUrl && !references.some(x => x.id === r.id)) references.push({ id: r.id, name: r.name, dataUrl });
            }
        }

        const result = await generateImageRequest(connId, {
            requestId,
            prompt: plan.prompt,
            aspectRatio: plan.aspect,
            references,
            referenceBindings,
            chatId: state.currentChatId ?? null,
            sourceMsgId: msgId,
        }, () => {}, controller.signal, {});

        const entry = result?.galleryEntry || {};
        upsertItem(msgId, { idx, type, descHash, status: 'ready', imagePath: entry.imagePath ?? null,
            cardId: entry.id ?? null, requestId, error: null, createdAt: Date.now() });
        recordDiagnosticEvent({ event: 'inline-end', requestId, outcome: 'ready', details: { msgId, type, cardId: entry.id ?? null } });
        emitInline('uris:inline-end', { requestId, msgId, idx, type, imagePath: entry.imagePath ?? null });
        return { requestId, imagePath: entry.imagePath ?? null, cardId: entry.id ?? null };
    } catch (e) {
        const cancelled = controller.signal.aborted || e?.name === 'AbortError';
        upsertItem(msgId, { idx, type, descHash, status: 'error', imagePath: null, cardId: null, requestId,
            error: cancelled ? 'aborted' : (e?.code || e?.message || String(e)), createdAt: Date.now() });
        recordDiagnosticEvent({ event: 'inline-end', requestId, outcome: cancelled ? 'cancelled' : 'error',
            details: { msgId, type, code: e?.code || null } });
        if (cancelled && e?.code == null) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
        throw e;
    } finally {
        state.activeGenerations.delete(requestId);
    }
}

/** Задача через автолейн (сериально с мостом). */
export function queueInlineJob(job) {
    return enqueueAutoLane(() => processJob(job));
}

/** Ручной перезапуск (реролл/retry): старая картинка остаётся в галерее. */
export function rerollInline(job) { return queueInlineJob(job); }
