// @ts-check
/**
 * Generation tab v3: prompt-first editor over message-scoped draft.
 * Layout: post-navigator, excerpt/stale badge, prompt editor, actions Stage 1 / Stage 2,
 * compact aspect/size/quality controls, references panel, Advanced (template/automation/queue).
 */
import { state, getCtx, escapeHtml, error, debounce, VALID_ASPECT_RATIOS, VALID_IMAGE_SIZES, abortGeneration } from '../core.js';
import { notifyStage1Ready } from '../events.js';
import { POST_FILTER, navigatePosts, getPostInfo, setFilter, setCurrentMsgId, getLastPostIndex } from '../post-navigator.js';
import { runStage1ForDraft, runStage2ForDraft, enqueueGeneration, createQueueItem, stopQueue, buildCandidates } from '../pipeline.js';
import { buildSceneContextSnapshot, resolvePromptReferenceContext } from '../scene-context.js';
import { getGenerationDraft, updateGenerationDraft, hashMessage, normalizeTemplateSelection, resolveDraftTemplateId } from '../generation-drafts.js';
import { listTemplates } from '../prompt-templates.js';
import { patchChatConfig, loadChatConfig } from '../chat-binding.js';
import { setStatus, lockBodyScroll, unlockBodyScroll } from './window.js';
import { getActiveTab, refreshActive } from './tabs.js';
import {
    getChatRefs, saveChatRefs, getRefSync, listFolders, listRefs,
} from '../refs-library.js';
import { effectiveReferenceCap } from '../reference-limits.js';
import { showPoolPicker } from './tab-references.js';
import { showSingleImage } from './lightbox.js';
import { bindDetailsToggle, getAccordionOpen } from './accordion-state.js';
import { editTextModal } from './text-editor.js';
import { resolveChatConfigSnapshot } from '../pipeline-config.js';
import { getConnection, isServerOwnedConnection, saveConnection } from '../connections.js';
import {
    resolveDispatchPlan,
    referenceEncoding,
    detectModelFamily,
    MODEL_FAMILIES,
    getVisibleModelChoices,
    classifyModelCapability,
} from '../dispatch-plan.js';
import { resolveServerOwnedReferencePolicy as resolveServerOwnedRouteReferencePolicy } from '../reference-policy.js';
import { recordUrisError } from '../error-pool.js';

// Module-level ref to the Generate tab root, so the singleton abort-UI listeners
// (bindAbortUI) can refresh the in-flight "Остановить" button and queue status
// without a full re-render (which would tear down the editor).
let _generateRoot = null;

// ── Prompt-first pure view helpers ──

/**
 * Decide the independent Stage 1 and Stage 2 action states from a draft.
 *
 * @param {import('../generation-drafts.js').GenerationDraft} draft
 * @returns {{stage1Action:'build-prompt'|'rebuild-prompt',canGenerateImage:boolean}}
 */
export function decidePromptActions(draft) {
    const hasPrompt = Boolean(draft?.prompt?.trim());
    return {
        stage1Action: hasPrompt ? 'rebuild-prompt' : 'build-prompt',
        canGenerateImage: hasPrompt,
    };
}

/**
 * Build the view model used by the Generate tab renderer.
 *
 * @param {{draft:import('../generation-drafts.js').GenerationDraft, snapshot:import('../core.js').SceneContextSnapshot|null, automationMode:import('../core.js').AutomationMode, templates:Array<{id:string,name:string}>, messageText:string, activeTemplateId?:string|null}} input
 * @returns {object}
 */
export function buildGenerateViewModel({ draft, snapshot, referenceResolution, automationMode, templates, messageText, activeTemplateId = null }) {
    const normalizedDraft = normalizeTemplateSelection(draft);
    // effectiveTemplateId: activeTemplateId is the default source; a draft-level
    // override (templateSelection === 'override') is authoritative, including the
    // explicit base-mode override where templateId is null.
    const effectiveTemplateId = resolveDraftTemplateId(normalizedDraft, activeTemplateId);
    const currentHash = hashMessage(messageText);
    const isStale = normalizedDraft.messageHash !== currentHash;
    const { stage1Action, canGenerateImage } = decidePromptActions(normalizedDraft);
    const isRunning = normalizedDraft.stage1?.status === 'running' || normalizedDraft.stage2?.status === 'running';
    const stage1Error = normalizedDraft.stage1?.status === 'error' ? normalizedDraft.stage1.error : null;
    const stage2Error = normalizedDraft.stage2?.status === 'error' ? normalizedDraft.stage2.error : null;

    // Stage 1 descriptions come from the historical source-message snapshot;
    // effective refs/ambiguities/entities come from the current prompt-driven
    // Stage 2 resolution.
    return {
        draft: normalizedDraft,
        snapshot,
        referenceResolution,
        automationMode,
        templates,
        messageText,
        activeTemplateId,
        effectiveTemplateId,
        isStale,
        stage1Action,
        canGenerateImage,
        isRunning,
        stage2RequestId: normalizedDraft.stage2?.requestId || null,
        stage1Error,
        stage2Error,
        ambiguities: referenceResolution?.ambiguities || snapshot?.ambiguities || [],
        refs: referenceResolution?.stage2Refs || snapshot?.stage2Refs || [],
        descriptions: snapshot?.stage1Descriptions || [],
        entities: referenceResolution?.entities || snapshot?.entities || [],
    };
}

/**
 * Compute a new message-scoped correction record from the current one.
 * Including a candidate removes any prior exclusion; excluding removes any
 * prior inclusion. The revision is always incremented.
 *
 * @param {{includedIds?:string[],excludedIds?:string[],revision?:number}} current
 * @param {string} candidateId
 * @param {boolean} include
 * @returns {{includedIds:string[],excludedIds:string[],revision:number}}
 */
export function updateReferenceCorrections(current, candidateId, include) {
    const included = new Set(current?.includedIds || []);
    const excluded = new Set(current?.excludedIds || []);
    if (include) {
        included.add(candidateId);
        excluded.delete(candidateId);
    } else {
        excluded.add(candidateId);
        included.delete(candidateId);
    }
    return {
        includedIds: Array.from(included),
        excludedIds: Array.from(excluded),
        revision: (current?.revision || 0) + 1,
    };
}

/**
 * Build the panel state shown in the Generate tab reference panel.
 *
 * @param {Array<{id:string}>} refs
 * @param {{supported:boolean,maxRefs:number|null,reason:string}} policy
 * @returns {{count:number,max:number|null,canAdd:boolean,unsupported:boolean,overLimit:boolean,message:string}}
 */
export function buildReferencePanelState(refs, policy) {
    const count = refs?.length || 0;
    if (!policy?.supported) {
        return {
            count,
            max: 0,
            canAdd: false,
            unsupported: true,
            overLimit: false,
            message: policy?.reason || 'Референсы недоступны для этого соединения.',
        };
    }
    const hasFiniteCap = Number.isSafeInteger(policy.maxRefs);
    const overLimit = hasFiniteCap && count > policy.maxRefs;
    return {
        count,
        max: policy.maxRefs ?? null,
        canAdd: !hasFiniteCap || count < policy.maxRefs,
        unsupported: false,
        overLimit,
        message: overLimit ? `Выбрано ${count} референсов, но маршрут поддерживает только ${policy.maxRefs}. Удалите лишние референсы перед генерацией.` : '',
    };
}

/** Resolve Stage 2 reference support advertised by a server-owned route. */
export function resolveServerOwnedReferencePolicy(conn) {
    return resolveServerOwnedRouteReferencePolicy(conn);
}

/** Resolve reference delivery from the saved route for either connection owner. */
export function resolveConnectionReferencePolicy(conn) {
    const route = conn?.selectedRoute;
    const capabilities = route?.capabilities || {};
    const source = isServerOwnedConnection(conn) ? 'server-route' : 'browser-route';
    if (capabilities.references === 'unsupported' || capabilities.maxReferences === 0) {
        return {
            supported: false,
            status: 'unsupported',
            protocol: null,
            maxRefs: 0,
            reason: 'Выбранный маршрут не принимает референсы.',
            source,
        };
    }
    return {
        supported: true,
        status: capabilities.references || 'unknown',
        protocol: null,
        maxRefs: effectiveReferenceCap({ providerCap: capabilities.maxReferences }),
        reason: '',
        source,
    };
}

/**
 * Render the effective Stage 2 reference chips for the preview panel.
 *
 * @param {Array<{id:string,name:string,imagePath:string}>} refs
 * @returns {string}
 */
export function renderReferencePreviewMarkup(refs) {
    if (!refs.length) return '';
    return refs.map(ref => {
        return `<div class="uris-ref-chip-preview" data-ref-id="${escapeHtml(ref.id)}" title="${escapeHtml(ref.name || '')}">` +
            `<img src="${escapeHtml(ref.imagePath || '')}" alt="${escapeHtml(ref.name || '')}">` +
            `<button class="uris-effective-ref-remove" title="Убрать из генерации" aria-label="Убрать из генерации"><i class="fa-solid fa-xmark"></i></button>` +
            `</div>`;
    }).join('');
}

/**
 * Render the ambiguity list markup from a resolution object.
 *
 * @param {Array<{mention:string,candidateIds:string[]}>} ambiguities
 * @param {Array<{id:string,name:string}>} entities
 * @returns {string}
 */
function renderAmbiguitiesMarkup(ambiguities, entities) {
    const entityName = (id) => escapeHtml(entities.find(e => e.id === id)?.name || id);
    return ambiguities.map(a => {
        const candidates = a.candidateIds.map(id =>
            `<span class="uris-ambiguity-candidate" data-candidate-id="${escapeHtml(id)}">` +
            `<span class="uris-candidate-name">${entityName(id)}</span>` +
            `<button class="menu_button uris-ref-include" title="Включить" aria-label="Включить" data-ambiguity="${escapeHtml(a.mention)}" data-candidate-id="${escapeHtml(id)}"><i class="fa-solid fa-plus"></i></button>` +
            `<button class="menu_button uris-ref-exclude" title="Исключить" aria-label="Исключить" data-ambiguity="${escapeHtml(a.mention)}" data-candidate-id="${escapeHtml(id)}"><i class="fa-solid fa-ban"></i></button>` +
            `</span>`
        ).join(' ');
        return `<div class="uris-ambiguity" data-ambiguity="${escapeHtml(a.mention)}">` +
            `<span class="uris-ambiguity-mention">${escapeHtml(a.mention)}</span>` +
            `<span class="uris-ambiguity-candidates">${candidates}</span>` +
            `</div>`;
    }).join('');
}

/**
 * Rebuild only the ambiguity list after a prompt edit, preserving focus.
 *
 * @param {HTMLElement} root
 * @param {import('../scene-context.js').SceneContextSnapshot|null} referenceResolution
 */
export function renderPromptAmbiguities(root, referenceResolution) {
    const host = root.querySelector('.uris-scene-context');
    if (!host) return;
    host.innerHTML = renderAmbiguitiesMarkup(
        referenceResolution?.ambiguities || [],
        referenceResolution?.entities || [],
    );
}

/**
 * Render the Generate tab markup from a view model.
 *
 * @param {ReturnType<buildGenerateViewModel>} vm
 * @returns {string}
 */
export function renderGenerateMarkup(vm) {
    const { draft, templates, isStale, stage1Action, canGenerateImage, isRunning, stage2RequestId, stage1Error, stage2Error, ambiguities, entities } = vm;
    const excerpt = escapeHtml((vm.messageText || '').slice(0, 120));
    const staleBadge = isStale ? '<span class="uris-draft-stale">исходное сообщение изменилось</span>' : '';
    const runningAttr = isRunning ? ' disabled' : '';
    const generateDisabledAttr = isRunning || !canGenerateImage ? ' disabled' : '';
    // #urisCancelImage is always rendered so setCancelState can toggle it live
    // (the pipeline dispatches uris:stage2-start/end); it stays hidden when idle.
    const cancelHidden = (isRunning && stage2RequestId) ? '' : ' hidden';
    const cancelRequestId = stage2RequestId ? escapeHtml(String(stage2RequestId)) : '';
    const stage1Label = stage1Action === 'build-prompt' ? 'Построить промпт' : 'Перестроить промпт';

    const effectiveId = vm.effectiveTemplateId ?? null;
    const effectiveUnknown = effectiveId !== null && !templates.some(t => t.id === effectiveId);
    const templateOptions = `<option value="" ${effectiveId === null ? 'selected' : ''}>— базовый режим —</option>` +
        templates.map(t => `<option value="${escapeHtml(t.id)}" ${t.id === effectiveId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('') +
        (effectiveUnknown
            ? `<option value="${escapeHtml(effectiveId)}" selected>${escapeHtml(effectiveId)}</option>`
            : '');

    const ambiguityList = renderAmbiguitiesMarkup(ambiguities, entities);

    // Stage 1/2 errors are no longer rendered as a red inline block — they
    // live in the header error pool (recordUrisError from the action handlers).

    const followOn = state.settings.followLastPost !== false;
    const followActiveClass = followOn ? ' is-active' : '';
    const followPressed = followOn ? 'true' : 'false';

    return `
        <div class="uris-gen">
            <div class="uris-postnav">
                <button class="uris-postnav-btn" id="urisPrev" title="Предыдущий пост" type="button" aria-label="Предыдущий пост"><i class="fa-solid fa-chevron-left"></i></button>
                <div class="uris-postnav-info" id="urisPostInfo" title="Текущий пост">—</div>
                <button class="uris-postnav-btn" id="urisNext" title="Следующий пост" type="button" aria-label="Следующий пост"><i class="fa-solid fa-chevron-right"></i></button>
                <button class="uris-postnav-btn uris-follow-toggle${followActiveClass}" id="urisFollowLast"
                    title="Следить за последним постом" aria-pressed="${followPressed}" type="button">
                    <i class="fa-solid fa-magnet"></i>
                </button>
            </div>

            <div class="uris-context-box">
                <div class="uris-source-excerpt">${excerpt}${staleBadge}</div>
                <div class="uris-scene-context">${ambiguityList}</div>
            </div>

            <div class="uris-prompt-card">
                <textarea class="text_pole uris-prompt-area" id="urisPrompt" rows="6" placeholder="Промпт картинки"${runningAttr}>${escapeHtml(draft.prompt || '')}</textarea>
                <button class="uris-expand-btn" id="urisPromptExpand" type="button" title="Развернуть редактор" aria-label="Развернуть редактор"${runningAttr}><i class="fa-solid fa-maximize"></i></button>
                <div class="uris-gen-actions">
                    <button class="uris-btn uris-btn-ghost" id="urisBuildPrompt"${runningAttr} type="button">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> ${stage1Label}
                    </button>
                    <button class="uris-btn uris-btn-primary" id="urisGenerateImage"${generateDisabledAttr} type="button">
                        <i class="fa-solid fa-image"></i> Сгенерировать
                    </button>
                    <button class="uris-btn uris-btn-danger" id="urisCancelImage" type="button" title="Остановить генерацию" aria-label="Остановить генерацию"${cancelHidden} data-request-id="${cancelRequestId}"><i class="fa-solid fa-stop"></i> Остановить</button>
                </div>
            </div>

            <div class="uris-gen-params">
                <span class="uris-param"><span class="uris-param-label">Стороны</span>
                    <select class="text_pole" id="urisAspect">${VALID_ASPECT_RATIOS.map(r => `<option ${r === draft.aspectRatio ? 'selected' : ''}>${r}</option>`).join('')}</select></span>
                <span class="uris-param"><span class="uris-param-label">Размер</span>
                    <select class="text_pole" id="urisImgSize">${VALID_IMAGE_SIZES.map(s => `<option ${s === draft.imageSize ? 'selected' : ''}>${s}</option>`).join('')}</select></span>
                <span class="uris-param"><span class="uris-param-label">Quality</span>
                    <select class="text_pole" id="urisQuality">${vm.qualityOptions || qualityOptionsFor('', draft.quality)}</select></span>
                <span class="uris-param"><span class="uris-param-label">Модель</span>${renderModelSelectMarkup(vm.modelChoices)}</span>
            </div>
            <div class="uris-gen-params">
                <span class="uris-param"><span class="uris-param-label">Шаблон</span>
                    <select class="text_pole" id="urisTemplate">${templateOptions}</select></span>
                <span class="uris-param"><span class="uris-param-label">Автоматизация</span>
                    <select class="text_pole" id="urisAutomationMode">
                        <option value="manual" ${vm.automationMode === 'manual' ? 'selected' : ''}>Вручную</option>
                        <option value="build-prompt" ${vm.automationMode === 'build-prompt' ? 'selected' : ''}>Строить промпт</option>
                        <option value="full-pipeline" ${vm.automationMode === 'full-pipeline' ? 'selected' : ''}>Полный pipeline</option>
                    </select></span>
                <span class="uris-param"><span class="uris-param-label">Флоу генерации</span>
                    <select class="text_pole" id="urisGenerationFlow">
                        <option value="${POST_FILTER.AI_ONLY}" ${state.settings.generationFlow === POST_FILTER.AI_ONLY ? 'selected' : ''}>Только AI</option>
                        <option value="${POST_FILTER.USER_ONLY}" ${state.settings.generationFlow === POST_FILTER.USER_ONLY ? 'selected' : ''}>Только пользователь</option>
                        <option value="${POST_FILTER.ALL}" ${state.settings.generationFlow === POST_FILTER.ALL ? 'selected' : ''}>Все сообщения</option>
                        <option value="${POST_FILTER.MANUAL}" ${state.settings.generationFlow === POST_FILTER.MANUAL ? 'selected' : ''}>Ручной выбор</option>
                    </select></span>
            </div>

            <div class="uris-refs-panel" id="urisRefsPanel">
                <div class="uris-refs-panel-head">
                    <span class="uris-refs-status-label">Референсы</span>
                </div>
                <div class="uris-refs-keywords" id="urisRefsKeywords">
                    <div class="uris-refs-keywords-row" id="urisRefsStage1Keywords"></div>
                    <div class="uris-refs-keywords-row" id="urisRefsStage2Keywords"></div>
                </div>
                <div class="uris-refs-panel-preview" id="urisRefsPreview" data-drop-zone="stage2"></div>
                <input type="hidden" id="urisRefsCap">
                <div class="uris-refs-sources-section">
                    <div class="uris-refs-sources-label">Whitelist референсов</div>
                    <div class="uris-refs-panel-extras" id="urisRefsWhitelist"></div>
                </div>
            </div>


            <div class="uris-queue-status" id="urisQueueStatus"></div>
        </div>`;
}

/**
 * Render a minimal placeholder when no post is selected yet (no chat open,
 * or initialization before CHAT_CHANGED sets a valid currentMsgId).
 * Keeps the post-navigator active so the user can pick a post manually.
 * @returns {string}
 */
function renderEmptyStateMarkup() {
    const followOn = state.settings.followLastPost !== false;
    const followActiveClass = followOn ? ' is-active' : '';
    const followPressed = followOn ? 'true' : 'false';
    return `
        <div class="uris-gen">
            <div class="uris-postnav">
                <button class="uris-postnav-btn" id="urisPrev" title="Предыдущий пост" type="button" aria-label="Предыдущий пост"><i class="fa-solid fa-chevron-left"></i></button>
                <div class="uris-postnav-info" id="urisPostInfo" title="Текущий пост">Нет подходящего поста</div>
                <button class="uris-postnav-btn" id="urisNext" title="Следующий пост" type="button" aria-label="Следующий пост"><i class="fa-solid fa-chevron-right"></i></button>
                <button class="uris-postnav-btn uris-follow-toggle${followActiveClass}" id="urisFollowLast"
                    title="Следить за последним постом" aria-pressed="${followPressed}" type="button">
                    <i class="fa-solid fa-magnet"></i>
                </button>
            </div>
            <div class="uris-prompt-card">
                <textarea class="text_pole uris-prompt-area" id="urisPrompt" rows="6" placeholder="Нет сообщения для генерации — выберите пост стрелками выше или откройте чат" disabled></textarea>
                <div class="uris-gen-actions">
                    <button class="uris-btn uris-btn-ghost" id="urisBuildPrompt" disabled type="button"><i class="fa-solid fa-wand-magic-sparkles"></i> Построить промпт</button>
                    <button class="uris-btn uris-btn-primary" id="urisGenerateImage" disabled type="button"><i class="fa-solid fa-image"></i> Сгенерировать</button>
                </div>
            </div>
        </div>`;
}

/**
 * Bind the empty-state post navigator. A successful navigation re-renders the
 * full Generate tab with a now-valid currentMsgId.
 * @param {HTMLElement} root
 */
function bindEmptyState(root) {
    const tryNav = (dir) => {
        navigatePosts(dir);
        if (state.currentMsgId != null) render(root);
    };
    root.querySelector('#urisPrev')?.addEventListener('click', () => tryNav(-1));
    root.querySelector('#urisNext')?.addEventListener('click', () => tryNav(1));
    root.querySelector('#urisFollowLast')?.addEventListener('click', () => {
        state.settings.followLastPost = state.settings.followLastPost === false;
        getCtx().saveSettingsDebounced?.();
        render(root);
    });
}

// Quality values that survive the wire for a model family (kept in sync with
// providers/image-openai.js acceptedQualityValues). Unknown families and
// non-OpenAI dialects keep the generic scale.
const QUALITY_BY_FAMILY = {
    [MODEL_FAMILIES.DALL_E]: ['auto', 'standard', 'hd'],
    default: ['auto', 'low', 'medium', 'high'],
};

/** Quality dropdown options for the selected model's family. */
export function qualityOptionsFor(modelId, current = '') {
    const values = QUALITY_BY_FAMILY[detectModelFamily(modelId)] || QUALITY_BY_FAMILY.default;
    const known = values.includes(current) ? current : values[0];
    return values.map(value => `<option value="${value}"${value === known ? ' selected' : ''}>${value}</option>`).join('');
}

/**
 * Resolve the model dropdown choices from the chat's active connection.
 * @returns {Promise<{connId:string, connName:string, ids:string[], current:string, manual:boolean}|null>}
 */
export async function resolveModelChoices(loadConnection = getConnection) {
    const snapshot = await resolveChatConfigSnapshot();
    const connId = snapshot.imageProfileId;
    if (!connId) return null;
    const conn = await loadConnection(connId);
    if (!conn) return null;
    // Image models by default. Unknown/text catalog entries remain hidden until
    // the user explicitly chooses them on the connection card or enters a
    // manual model id; an empty recognized set must stay empty, not fall back
    // to a text catalog.
    const visible = getVisibleModelChoices(
        conn?.detected?.modelIds || [],
        { metadata: conn?.detected?.modelMetadata || [] },
    );
    const ids = visible.ids;
    const catalogIds = Array.isArray(conn?.detected?.modelIds) ? conn.detected.modelIds : [];
    const metadata = Array.isArray(conn?.detected?.modelMetadata) ? conn.detected.modelMetadata : [];
    const binding = await loadChatConfig();
    const chatModel = binding.config.generationDefaults?.modelId || '';
    const chatClassification = chatModel ? classifyModelCapability(chatModel, metadata.find(item => item?.modelId === chatModel) || {}) : null;
    const validChatModel = chatModel && chatClassification?.kind !== 'non-image' && (!catalogIds.length || catalogIds.includes(chatModel)) ? chatModel : '';
    const current = validChatModel || (state.settings?.useParametersForAllChats === true
        ? (state.settings.globalGenerationDefaults?.modelId || '') : '') || conn?.model?.id || '';
    const currentClassification = current ? classifyModelCapability(current, metadata.find(item => item?.modelId === current) || {}) : null;
    const manual = !current || (ids.length > 0 && !ids.includes(current));
    return {
        connId,
        connName: conn?.name || connId,
        ids,
        current,
        manual,
        chatOverride: Boolean(validChatModel),
        classifications: visible.classifications,
        currentClassification,
    };
}

/**
 * Render the model select for the params row. Write-through: picking a model
 * updates the connection (globally, for every chat).
 * @param {{connId:string, connName:string, ids:string[], current:string, manual:boolean}|null} choices
 */
export function renderModelSelectMarkup(choices) {
    if (!choices) {
        return `<select class="text_pole" id="urisModel" disabled title="Выберите image-коннект во вкладке API"><option>нет коннекта</option></select>`;
    }
    if (!choices.ids.length) {
        const emptyOption = choices.current
            ? `${escapeHtml(choices.current)} (вручную)`
            : 'модель не выбрана';
        return `<select class="text_pole" id="urisModel" disabled title="Список моделей пуст — нажмите «Проверить» на карточке коннекта или введите ID модели вручную"><option>${emptyOption}</option></select>`;
    }
    const options = choices.ids.map(id => {
        const classification = choices.classifications?.find(item => item.modelId.toLowerCase() === id.toLowerCase());
        const disabled = classification?.kind === 'non-image';
        const label = disabled ? `${id} (не image)` : id;
        return `<option value="${escapeHtml(id)}"${id === choices.current && !choices.manual ? ' selected' : ''}${disabled ? ' disabled' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
    const manualOption = choices.current && choices.manual
        ? `<option value="${escapeHtml(choices.current)}" selected>${escapeHtml(choices.current)} (вручную)</option>`
        : '';
    const source = choices.chatOverride ? 'Переопределение текущего чата' : `По умолчанию: коннект «${escapeHtml(choices.connName)}»`;
    return `<select class="text_pole" id="urisModel" title="${source}">${options}${manualOption}</select>`;
}

/**
 * Bind the model dropdown: write-through to the connection, with the visible
 * prompt/params flushed into the draft first so the re-render loses nothing.
 */
export function bindModelSelect(root, choices, options = {}) {
    const select = root.querySelector('#urisModel');
    if (!select || !choices?.connId) return;
    select.addEventListener('change', async () => {
        const modelId = select.value;
        if (!modelId) return;
        try {
            const ctx = getCtx();
            const msgId = state.currentMsgId;
            await patchChatConfig({ generationDefaults: { modelId } });
            state.generationDefaults = { ...(state.generationDefaults || {}), modelId };
            if (msgId != null && ctx.chat?.[msgId]) {
                const messageText = ctx.chat[msgId].mes || '';
                const params = readGenerationParams(root, {});
                await updateGenerationDraft(ctx.chatId, msgId, messageText, d => ({
                    ...d,
                    prompt: root.querySelector('#urisPrompt')?.value || '',
                    ...params,
                }));
            }
            options.onSwitched?.(modelId);
        } catch (e) {
            recordUrisError({ scope: 'Параметры', message: `Не удалось сменить модель: ${e?.message || e}` });
            toastr?.error('Не удалось сменить модель: ' + (e?.message || e));
        }
    });
}

/**
 * Render the Generate tab UI into the given root element.
 * @param {HTMLElement} root
 */
export async function render(root) {
    _generateRoot = root;
    const renderEpoch = root.__urisRenderEpoch;
    const isCurrent = () => root.__urisRenderEpoch === renderEpoch && root.__urisTabId === 'generate';
    const ctx = getCtx();
    const chatId = ctx.chatId;
    const msgId = state.currentMsgId;

    // Guard: if no chat is open or no valid msgId exists (e.g., initialization
    // before CHAT_CHANGED), render the empty state instead of calling
    // getGenerationDraft(chatId, null, ...) — generationDraftKey throws,
    // async-render rejects, and the tab stays blank.
    if (!chatId || msgId == null || !ctx.chat?.[msgId]) {
        root.innerHTML = renderEmptyStateMarkup();
        bindEmptyState(root);
        return;
    }

    const messageText = ctx.chat[msgId].mes || '';

    const draft = await getGenerationDraft(chatId, msgId, messageText);
    if (!isCurrent()) return;
    const chatBinding = await loadChatConfig();
    if (!isCurrent()) return;
    const defaults = state.settings?.useParametersForAllChats === true
        ? {
            modelId: chatBinding.config.generationDefaults?.modelId ?? state.settings.globalGenerationDefaults?.modelId ?? null,
            aspectRatio: chatBinding.config.generationDefaults?.aspectRatio ?? state.settings.globalGenerationDefaults?.aspectRatio ?? null,
            imageSize: chatBinding.config.generationDefaults?.imageSize ?? state.settings.globalGenerationDefaults?.imageSize ?? null,
            quality: chatBinding.config.generationDefaults?.quality ?? state.settings.globalGenerationDefaults?.quality ?? null,
        }
        : (chatBinding.config.generationDefaults || {});
    const effectiveDraft = {
        ...draft,
        aspectRatio: defaults.aspectRatio || draft.aspectRatio,
        imageSize: defaults.imageSize || draft.imageSize,
        quality: defaults.quality || draft.quality,
    };
    const snapshot = effectiveDraft.stage1?.contextSnapshot || null;
    const referenceResolution = await resolveDraftPromptReferences(chatId, effectiveDraft);
    if (!isCurrent()) return;
    const templates = await listTemplates();
    if (!isCurrent()) return;
    const vm = buildGenerateViewModel({
        draft: effectiveDraft,
        snapshot,
        referenceResolution,
        automationMode: state.settings.automationMode,
        templates,
        messageText,
        activeTemplateId: state.activeTemplateId,
    });

    const modelChoices = await resolveModelChoices();
    if (!isCurrent()) return;
    root.innerHTML = renderGenerateMarkup({ ...vm, modelChoices, qualityOptions: qualityOptionsFor(modelChoices?.current || '', effectiveDraft.quality) });
    bindGenerate(root);
    syncCancelState(root);
    bindModelSelect(root, modelChoices, { onSwitched: () => render(root) });
    updatePostInfo(root);
    refreshReferencePanel(root, referenceResolution, snapshot);
}

/**
 * Resolve the current prompt-driven Stage 2 reference set for a draft.
 *
 * @param {string} chatId
 * @param {import('../generation-drafts.js').GenerationDraft} draft
 * @returns {Promise<import('../scene-context.js').SceneContextSnapshot>}
 */
async function resolveDraftPromptReferences(chatId, draft) {
    const candidates = await buildCandidates(chatId);
    return await resolvePromptReferenceContext({
        prompt: draft.prompt,
        candidates,
        corrections: draft.references || { includedIds: [], excludedIds: [], revision: 0 },
    });
}

// ── Bindings ──

/**
 * Read the generation parameters currently visible in the Generate tab.
 * @param {HTMLElement} root
 * @param {import('../generation-drafts.js').GenerationDraft} draft
 * @returns {{aspectRatio:string,imageSize:string,quality:string}}
 */
export function readGenerationParams(root, draft) {
    const aspectRatio = root.querySelector('#urisAspect')?.value || draft.aspectRatio;
    const imageSize = root.querySelector('#urisImgSize')?.value || draft.imageSize;
    const quality = root.querySelector('#urisQuality')?.value || draft.quality;
    return { aspectRatio, imageSize, quality };
}

/** Persist the visible editor state, marking only actual prompt changes as manual. */
export async function persistVisibleGenerationDraft({ draft, visiblePrompt, params, persist }) {
    const promptChanged = visiblePrompt !== draft.prompt;
    await persist(current => ({
        ...current,
        prompt: visiblePrompt,
        promptOrigin: promptChanged ? 'manual' : current.promptOrigin,
        ...params,
    }));
}

/** Create a debounced prompt writer whose cancelled callbacks become inert. */
export function createCancellablePromptAutosave({ persist, delay = 400, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let timer = null;
    let revision = 0;
    return {
        schedule(value) {
            const scheduledRevision = ++revision;
            if (timer !== null) clearTimer(timer);
            timer = setTimer(async () => {
                if (scheduledRevision !== revision) return;
                timer = null;
                await persist(value);
            }, delay);
        },
        cancel() {
            revision++;
            if (timer !== null) clearTimer(timer);
            timer = null;
        },
    };
}

/** Dispatch one generation stage while locking both action buttons. */
export async function executeGenerationAction({ action, input, buttons, runStage1, runStage2, lock = { active: false } }) {
    if (lock.active) return undefined;
    lock.active = true;
    const priorDisabled = buttons.map(button => Boolean(button?.disabled));
    for (const button of buttons) if (button) button.disabled = true;
    try {
        return action === 'stage1' ? await runStage1(input) : await runStage2(input);
    } finally {
        buttons.forEach((button, index) => { if (button) button.disabled = priorDisabled[index]; });
        lock.active = false;
    }
}

/**
 * Bind all Generate tab event listeners to the rendered root.
 * @param {HTMLElement} root
 */
export function bindGenerate(root) {
    // Post navigator — re-render the whole tab on navigation so the draft switches.
    root.querySelector('#urisPrev').addEventListener('click', () => { navigatePosts(-1); render(root); });
    root.querySelector('#urisNext').addEventListener('click', () => { navigatePosts(1); render(root); });

    // Follow-last-post toggle: flips the global flag, persists, and on enable
    // snaps the navigator to the last post immediately. Manual arrow nav never
    // clears the flag — only this click does.
    root.querySelector('#urisFollowLast')?.addEventListener('click', () => {
        state.settings.followLastPost = state.settings.followLastPost === false;
        getCtx().saveSettingsDebounced?.();
        if (state.settings.followLastPost) {
            setCurrentMsgId(getLastPostIndex());
        }
        render(root);
    });

    // Prompt autosave: editing sets origin to manual and refreshes the prompt-driven preview.
    const promptEl = root.querySelector('#urisPrompt');
    const autosave = debounce(async () => {
        const ctx = getCtx();
        const chatId = ctx.chatId;
        const msgId = state.currentMsgId;
        const messageText = ctx.chat?.[msgId]?.mes || '';
        const savedDraft = await updateGenerationDraft(chatId, msgId, messageText, d => ({
            ...d,
            prompt: promptEl?.value || '',
            promptOrigin: d.prompt ? 'manual' : d.promptOrigin,
        }));
        // Only refresh if the user is still on the same message.
        if (getCtx().chatId === chatId && state.currentMsgId === msgId) {
            const resolution = await resolveDraftPromptReferences(chatId, savedDraft);
            renderMatchedKeywords(root, undefined, resolution);
            await renderLivePreview(root, resolution);
            renderPromptAmbiguities(root, resolution);
        }
    }, 400);
    promptEl?.addEventListener('input', autosave);

    // Expanded editor (ST-style maximized_textarea popup). On OK the value is
    // written back and the normal input autosave (draft + live preview refresh)
    // runs unchanged; Cancel (null) keeps the current text.
    root.querySelector('#urisPromptExpand')?.addEventListener('click', async () => {
        if (!promptEl) return;
        const next = await editTextModal({ value: promptEl.value, title: 'Промпт картинки', placeholder: 'Промпт картинки' });
        if (next === null || next === promptEl.value) return;
        promptEl.value = next;
        promptEl.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Effective reference controls: remove from preview (add moved to + tile inside renderLivePreview).
    root.querySelector('#urisRefsPreview')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('.uris-effective-ref-remove');
        if (!btn) {
            // Тап по самому тайлу референса — открыть картинку на весь экран
            // (зум/пан PhotoSwipe). Крестик удаления остаётся приоритетным.
            const chip = e.target.closest('.uris-ref-chip-preview');
            const img = chip?.querySelector('img');
            if (img?.getAttribute('src')) {
                showSingleImage({ src: img.getAttribute('src'), prompt: chip.title || '' });
            }
            return;
        }
        const chipEl = btn.closest('.uris-ref-chip-preview');
        const refId = chipEl?.dataset.refId;
        if (!refId) return;
        await applyReferenceCorrection(root, refId, false);
    });

    const prepareRunInput = async () => {
        const ctx = getCtx();
        const chatConfig = await resolveChatConfigSnapshot();
        const msgId = state.currentMsgId;
        if (msgId == null) {
            toastr?.warning('Нет поста');
            return null;
        }
        const messageText = ctx.chat?.[msgId]?.mes || '';
        const currentDraft = await getGenerationDraft(ctx.chatId, msgId, messageText);
        const templateId = resolveDraftTemplateId(currentDraft, state.activeTemplateId);
        const params = readGenerationParams(root, currentDraft);
        await updateGenerationDraft(ctx.chatId, msgId, messageText, d => ({
            ...d,
            prompt: promptEl?.value || '',
            ...params,
        }));
        return { chatId: ctx.chatId, msgId, messageText, templateId, chatConfig };
    };

    // Stage 1 always builds or rebuilds the prompt independently of Stage 2.
    const buildPromptButton = root.querySelector('#urisBuildPrompt');
    buildPromptButton?.addEventListener('click', withBusy(buildPromptButton, async () => {
        try {
            const input = await prepareRunInput();
            if (!input) return;
            setStatus('Построение промпта...');
            const run = await runStage1ForDraft(input, s => setStatus(s));
            if (run.applied) {
                notifyStage1Ready(run.draft.prompt);
                setStatus('Промпт готов');
                toastr?.success('Промпт построен');
            }
        } catch (e) {
            error('Generate action:', e.message);
            recordUrisError({ scope: 'Stage 1', message: e.message });
            toastr?.error(e.message);
            setStatus('');
        }
        await render(root);
    }));

    // Stage 2 always generates from the saved prompt currently visible in the editor.
    const generateImageButton = root.querySelector('#urisGenerateImage');
    generateImageButton?.addEventListener('click', withBusy(generateImageButton, async () => {
        try {
            const input = await prepareRunInput();
            if (!input) return;
            setStatus('Генерация изображения...');
            const result = await runStage2ForDraft(input, s => setStatus(s));
            setStatus('Готово');
            toastr?.success('Картинка сгенерирована');
            // Provider warnings (dropped size/quality etc.) — surface, don't bury.
            if (Array.isArray(result?.warnings)) {
                for (const warning of result.warnings) {
                    toastr?.warning(`${warning.feature}: ${warning.details}`);
                }
            }
            if (getActiveTab() === 'gallery') refreshActive();
        } catch (e) {
            if (e?.name === 'AbortError') {
                toastr?.info('Генерация отменена');
                await render(root);
            } else {
                error('Generate action:', e.message);
                recordUrisError({ scope: 'Генерация', message: e.message });
                toastr?.error(e.message);
            }
            setStatus('');
        }
        // Deliberately no `await render(root)` here: re-rendering the tab would
        // tear down the editor DOM, discard the user's scroll position and
        // focus, and visually look like the tab was switched out from under
        // the user. The generation toast already confirms success; the draft
        // state is persisted and will surface naturally on the next render.
        // (AbortError is the exception: cancellation should refresh the UI to
        // hide the Cancel button and reflect the 'cancelled' draft status.)
    }));

    // Cancel an in-flight Stage 2 generation by requestId.
    const cancelButton = root.querySelector('#urisCancelImage');
    cancelButton?.addEventListener('click', () => {
        const requestId = cancelButton.getAttribute('data-request-id');
        if (!requestId) return;
        const aborted = abortGeneration(requestId);
        if (!aborted) {
            toastr?.warning('Генерация уже завершена');
        }
    });

    // Format/quality selectors are chat-scoped defaults. Persist on change so a
    // manual choice survives re-render, navigation, and chat reloads.
    const saveGenerationDefault = async (key, value) => {
        await patchChatConfig({ generationDefaults: { [key]: value || null } });
        state.generationDefaults = { ...(state.generationDefaults || {}), [key]: value || null };
        const ctx = getCtx();
        const msgId = state.currentMsgId;
        if (msgId != null && ctx.chat?.[msgId]) {
            const messageText = ctx.chat[msgId].mes || '';
            await updateGenerationDraft(ctx.chatId, msgId, messageText, d => ({ ...d, [key]: value || d[key] }));
        }
    };
    for (const [selector, key] of [['#urisAspect', 'aspectRatio'], ['#urisImgSize', 'imageSize'], ['#urisQuality', 'quality']]) {
        root.querySelector(selector)?.addEventListener('change', async e => {
            try {
                await saveGenerationDefault(key, e.target.value);
            } catch (e) {
                recordUrisError({ scope: 'Параметры', message: `Не удалось сохранить ${key}: ${e?.message || e}` });
                toastr?.error(`Не удалось сохранить параметр: ${e?.message || e}`);
            }
        });
    }

    // Generation flow selector
    root.querySelector('#urisGenerationFlow')?.addEventListener('change', async e => {
        const flow = e.target.value;
        state.settings.generationFlow = flow;
        setFilter(flow);
        await patchChatConfig({ generationFlow: flow });
        getCtx().saveSettingsDebounced();
    });

    // Automation mode selector
    root.querySelector('#urisAutomationMode')?.addEventListener('change', async e => {
        const mode = e.target.value;
        state.settings.automationMode = mode;
        await patchChatConfig({ automationMode: mode });
        getCtx().saveSettingsDebounced();
    });

    // Template is a chat-wide default. Keep legacy draft override fields aligned
    // for old consumers, but make the metadata choice authoritative for new runs.
    root.querySelector('#urisTemplate')?.addEventListener('change', async () => {
        const ctx = getCtx();
        const msgId = state.currentMsgId;
        const templateId = root.querySelector('#urisTemplate')?.value || null;
        try {
            await patchChatConfig({ templateId });
            state.activeTemplateId = templateId;
            if (msgId != null && ctx.chat?.[msgId]) {
                const messageText = ctx.chat[msgId].mes || '';
                await updateGenerationDraft(ctx.chatId, msgId, messageText, d => ({
                    ...d,
                    templateSelection: 'default',
                    templateId: null,
                }));
            }
        } catch (e) {
            recordUrisError({ scope: 'Параметры', message: `Не удалось сохранить шаблон: ${e?.message || e}` });
            toastr?.error(`Не удалось сохранить шаблон: ${e?.message || e}`);
        }
    });

    // Ambiguity include/exclude controls
    root.querySelector('.uris-scene-context')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('.uris-ref-include, .uris-ref-exclude');
        if (!btn) return;
        const candidateId = btn.dataset.candidateId;
        const include = btn.classList.contains('uris-ref-include');
        await applyReferenceCorrection(root, candidateId, include);
    });

}

/**
 * Apply a manual inclusion/exclusion correction for an ambiguous mention,
 * rebuild the shared snapshot, and re-render the tab.
 * @param {HTMLElement} root
 * @param {string} candidateId
 * @param {boolean} include
 */
async function applyReferenceCorrection(root, candidateId, include) {
    const ctx = getCtx();
    const msgId = state.currentMsgId;
    if (msgId == null) return;
    const messageText = ctx.chat?.[msgId]?.mes || '';

    await updateGenerationDraft(ctx.chatId, msgId, messageText, d => ({
        ...d,
        references: updateReferenceCorrections(d.references, candidateId, include),
    }));

    // A prompt reference correction must not mutate the historical Stage 1 input.
    // The next render will recompute the prompt-driven Stage 2 preview from the
    // current draft prompt and the updated corrections.
    await render(root);
}

/**
 * Pin selected pool IDs in Stage 2 and add them to the chat whitelist.
 * @param {HTMLElement} root
 * @param {string[]} refIds
 */
async function addStage2Includes(root, refIds) {
    const chatRefs = getChatRefs();
    const nextIds = [...chatRefs.referenceIds];
    for (const refId of refIds) {
        if (!nextIds.includes(refId)) nextIds.push(refId);
    }
    saveChatRefs({ referenceIds: nextIds });
    for (const refId of refIds) {
        await applyReferenceCorrection(root, refId, true);
    }
}

export async function enqueueCurrent(root, requestedAction) {
    try {
        const ctx = getCtx();
        const msgId = state.currentMsgId;
        if (msgId == null) { toastr?.warning('Нет поста'); return; }
        const messageText = ctx.chat?.[msgId]?.mes || '';
        const currentDraft = await getGenerationDraft(ctx.chatId, msgId, messageText);
        const templateId = resolveDraftTemplateId(currentDraft, state.activeTemplateId);
        const item = await createQueueItem({ chatId: ctx.chatId, msgId, messageText, requestedAction, templateId });
        const queued = enqueueGeneration(item);
        updateQueueStatus(root);
        toastr?.info('Добавлено в очередь');
        await queued;
        toastr?.success('Готово (из очереди)');
        updateQueueStatus(root);
        if (getActiveTab() === 'gallery') refreshActive();
    } catch (e) {
        recordUrisError({ scope: 'Очередь', message: 'Очередь: ' + (e?.message || e) });
        toastr?.error('Очередь: ' + (e?.message || e));
        updateQueueStatus(root);
    }
}

/**
 * Disable a button while an async operation runs to prevent double-clicks.
 * @param {HTMLButtonElement|null} btn
 * @param {function(): Promise<void>} fn
 * @returns {function(): Promise<void>}
 */
function withBusy(btn, fn) {
    return async () => {
        if (!btn || btn.disabled) return;
        btn.disabled = true;
        try { await fn(); } finally { btn.disabled = false; }
    };
}

/**
 * Update the post navigator info text for the current post.
 * @param {HTMLElement} root
 */
// ── Phase 1: references on the Generate tab (read-back + chat-scoped controls) ──

/**
 * Render the unified panel: effective preview, chat whitelist, and Stage 1 descriptions.
 * @param {HTMLElement} root
 */
export async function refreshReferencePanel(root, referenceResolution = null, stage1Snapshot = undefined) {
    if (!root.querySelector('#urisRefsPanel')) return;
    const chatRefs = getChatRefs();
    if (stage1Snapshot !== undefined) renderMatchedKeywords(root, stage1Snapshot, referenceResolution);

    // Mode badge removed (there used to be an <input id="urisRefsModeBadge"> here whose
    // innerHTML was a no-op on <input>). The cap indicator moves to the
    // "Отправится в генерацию" line (rendered inside renderLivePreview as .uris-refs-stage2-cap).

    // Live preview "will be sent" — driven by the current prompt, not the historical Stage 1 snapshot.
    await renderLivePreview(root, referenceResolution);
    renderPromptAmbiguities(root, referenceResolution);

    // Cap warning leaves a separate #urisRefsCap as a fallback/legacy host.
    await renderCap(root, referenceResolution);

    // Pool-backed source sections: persistent open/close (src/ui/accordion-state.js).
    // Previously open was derived from data presence — now it is fully manual: the user
    // decides whether to collapse or expand, and the choice persists across reloads.
    bindDetailsToggle(
        root.querySelector('details.uris-advanced'),
        'generate:advanced',
    );

    await renderWhitelistChips(root, chatRefs);
}

function renderMatchedKeywords(root, stage1Snapshot, stage2Resolution) {
    const render = (host, label, matches) => {
        if (!host) return;
        const items = Array.isArray(matches) ? matches : [];
        const chips = items.flatMap(match => (match.matchedPhrases || []).map(phrase =>
            `<span class="uris-refs-keyword-chip" title="${escapeHtml(match.name || match.id)}">${escapeHtml(phrase)} <small>→ ${escapeHtml(match.name || match.id)}</small></span>`
        )).join('');
        host.innerHTML = `<span class="uris-refs-keywords-label">${label}</span>${chips || '<small class="uris-refs-empty">нет совпадений</small>'}`;
    };
    if (stage1Snapshot !== undefined) {
        render(root.querySelector('#urisRefsStage1Keywords'), 'Stage 1 распознано', stage1Snapshot?.matchedReferences || []);
    }
    if (stage2Resolution !== undefined) {
        render(root.querySelector('#urisRefsStage2Keywords'), 'Stage 2 распознано', stage2Resolution?.matchedReferences || []);
    }
}

async function showFolderPicker({ title = 'Выберите папки', excludeIds = [] } = {}) {
    const folders = await listFolders();
    const available = folders.filter(folder => !excludeIds.includes(folder.id));
    if (!available.length) {
        toastr?.info('Нет доступных папок. Создайте папку во вкладке «Референсы».');
        return [];
    }
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'uris-picker-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.innerHTML = `<div class="uris-picker-dialog uris-folder-picker-dialog">
            <h4>${escapeHtml(title)}</h4>
            <div class="uris-folder-picker-list">${available.map(folder => `<button type="button" class="uris-folder-picker-item" data-folder-id="${escapeHtml(folder.id)}">
                <span class="uris-folder-dot" style="background:${escapeHtml(folder.color)}"></span>${escapeHtml(folder.name)}
            </button>`).join('')}</div>
            <div class="uris-picker-actions"><button type="button" class="uris-btn uris-btn-ghost uris-folder-picker-cancel">Отмена</button><button type="button" class="uris-btn uris-btn-primary uris-folder-picker-ok">Готово</button></div>
        </div>`;
        document.body.appendChild(overlay);
        lockBodyScroll();
        const selected = new Set();
        overlay.querySelectorAll('.uris-folder-picker-item').forEach(item => item.addEventListener('click', () => {
            const id = item.dataset.folderId;
            if (selected.has(id)) selected.delete(id); else selected.add(id);
            item.classList.toggle('uris-pick-selected', selected.has(id));
        }));
        const finish = value => { overlay.remove(); unlockBodyScroll(); resolve(value); };
        overlay.querySelector('.uris-folder-picker-cancel')?.addEventListener('click', () => finish([]));
        overlay.querySelector('.uris-folder-picker-ok')?.addEventListener('click', () => finish([...selected]));
    });
}

async function renderWhitelistChips(root, chatRefs) {
    const host = root.querySelector('#urisRefsWhitelist');
    if (!host) return;
    const [folders, refs] = await Promise.all([listFolders(), listRefs()]);
    const byId = new Map(refs.map(ref => [ref.id, ref]));
    const selectedFolderIds = chatRefs.folderIds || [];
    const displayedIds = new Set();
    const renderChip = (ref, direct = false) => {
        if (!ref) return '';
        const aliasTitle = ref.aliases?.length ? ref.aliases.join(', ') : 'Без aliases: только ручное добавление';
        const remove = direct
            ? '<button class="uris-extra-del" title="Убрать карточку из whitelist" aria-label="Убрать"><i class="fa-solid fa-xmark"></i></button>'
            : '';
        return `<span class="uris-extra-chip" data-ref-id="${escapeHtml(ref.id)}" title="${escapeHtml(aliasTitle)}">
            <img src="${escapeHtml(ref.imagePath)}" alt="${escapeHtml(ref.name)}">
            <span class="uris-extra-name">${escapeHtml(ref.name)}</span>
            ${remove}
        </span>`;
    };
    const renderStaleRef = id => `<span class="uris-extra-chip uris-ref-stale" data-ref-id="${escapeHtml(id)}" title="Запись пула не найдена">
        <span class="uris-extra-name">${escapeHtml(id)}</span>
        <button class="uris-extra-del" title="Убрать" aria-label="Убрать"><i class="fa-solid fa-xmark"></i></button>
    </span>`;
    const folderGroups = [];
    const directRefs = chatRefs.referenceIds.map(id => byId.get(id) || { id, missing: true });
    directRefs.forEach(ref => displayedIds.add(ref.id));
    const directMarkup = directRefs.map(ref => ref.missing ? renderStaleRef(ref.id) : renderChip(ref, true)).join('');
    const directGroup = `<div class="uris-refs-whitelist-group uris-refs-whitelist-direct">
        <div class="uris-refs-whitelist-group-head"><span>Отдельные карточки</span></div>
        <div class="uris-refs-whitelist-group-cards">${directMarkup || '<small class="uris-refs-empty">нет</small>'}</div>
    </div>`;

    for (const folderId of selectedFolderIds) {
        const folder = folders.find(item => item.id === folderId);
        const folderRefs = refs.filter(ref => ref.folders?.includes(folderId) && !displayedIds.has(ref.id));
        folderRefs.forEach(ref => displayedIds.add(ref.id));
        folderGroups.push(`<div class="uris-refs-whitelist-group" data-folder-id="${escapeHtml(folderId)}">
            <div class="uris-refs-whitelist-group-head"><span>${escapeHtml(folder?.name || folderId)}</span><button type="button" class="uris-folder-remove" data-folder-id="${escapeHtml(folderId)}" title="Убрать папку из whitelist" aria-label="Убрать папку"><i class="fa-solid fa-xmark"></i></button></div>
            <div class="uris-refs-whitelist-group-cards">${folderRefs.length ? folderRefs.map(ref => renderChip(ref)).join('') : '<small class="uris-refs-empty">нет карточек</small>'}</div>
        </div>`);
    }
    const staleFolders = selectedFolderIds.filter(id => !folders.some(folder => folder.id === id));
    for (const folderId of staleFolders) {
        folderGroups.push(`<div class="uris-refs-whitelist-group uris-ref-stale" data-folder-id="${escapeHtml(folderId)}"><div class="uris-refs-whitelist-group-head"><span>${escapeHtml(folderId)} (папка не найдена)</span><button type="button" class="uris-folder-remove" data-folder-id="${escapeHtml(folderId)}" title="Убрать" aria-label="Убрать папку"><i class="fa-solid fa-xmark"></i></button></div></div>`);
    }
    host.innerHTML = `<div class="uris-refs-whitelist-actions">
        <button class="uris-refs-add-tile uris-add-extra" title="Добавить референс в whitelist" aria-label="Добавить референс в whitelist"><i class="fa-solid fa-plus"></i></button>
        <button class="uris-refs-add-tile uris-add-folder" title="Добавить папку в whitelist" aria-label="Добавить папку в whitelist"><i class="fa-solid fa-folder-plus"></i></button>
    </div>${directGroup}${folderGroups.join('')}`;

    host.querySelector('.uris-add-extra')?.addEventListener('click', async () => {
        const current = getChatRefs().referenceIds;
        const chosen = await showPoolPicker({ title: 'Whitelist референсов', multi: true, excludeIds: current });
        if (chosen?.length) {
            saveChatRefs({ referenceIds: [...current, ...chosen] });
            await refreshReferencePanel(root, await resolveCurrentRootReferences(root));
        }
    });
    host.querySelector('.uris-add-folder')?.addEventListener('click', async () => {
        const current = getChatRefs().folderIds || [];
        const chosen = await showFolderPicker({ title: 'Папки в whitelist', excludeIds: current });
        if (chosen?.length) {
            saveChatRefs({ folderIds: [...current, ...chosen] });
            await refreshReferencePanel(root, await resolveCurrentRootReferences(root));
        }
    });
    host.querySelectorAll('.uris-extra-del').forEach(btn => {
        btn.addEventListener('click', async event => {
            event.stopPropagation();
            const refId = btn.closest('.uris-extra-chip')?.dataset.refId;
            if (!refId) return;
            const current = getChatRefs().referenceIds;
            saveChatRefs({ referenceIds: current.filter(id => id !== refId) });
            await refreshReferencePanel(root, await resolveCurrentRootReferences(root));
        });
    });
    host.querySelectorAll('.uris-folder-remove').forEach(btn => {
        btn.addEventListener('click', async event => {
            event.stopPropagation();
            const folderId = btn.dataset.folderId;
            if (!folderId) return;
            const current = getChatRefs().folderIds || [];
            saveChatRefs({ folderIds: current.filter(id => id !== folderId) });
            await refreshReferencePanel(root, await resolveCurrentRootReferences(root));
        });
    });
    host.querySelectorAll('.uris-extra-chip').forEach(chip => {
        if (chip.classList.contains('uris-ref-stale')) return;
        const refId = chip.dataset.refId;
        if (refId) makeChipDraggable(chip, refId, async id => { await applyReferenceCorrection(root, id, true); });
    });
}

/**
 * Pointer-Events drag of a whitelist chip onto a [data-drop-zone] target.
 * A clone ("ghost") follows the pointer via transform (compositor-only); the
 * source only dims. Drop commits a single action - no re-render during drag.
 * Works for mouse, touch and pen; touch-action:none on the chip prevents the
 * browser from hijacking the gesture as a scroll.
 */
function makeChipDraggable(chip, refId, onDrop) {
    chip.classList.add('uris-draggable');
    chip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.uris-extra-del')) return;
        const startX = e.clientX, startY = e.clientY;
        const r = chip.getBoundingClientRect();
        const grabX = startX - r.left, grabY = startY - r.top;
        let ghost = null, dragging = false, overZone = null;
        const THRESHOLD = 4;
        const move = (ev) => {
            const dx = ev.clientX - startX, dy = ev.clientY - startY;
            if (!dragging) {
                if (dx * dx + dy * dy < THRESHOLD * THRESHOLD) return;
                dragging = true;
                ghost = chip.cloneNode(true);
                ghost.classList.add('uris-drag-ghost');
                ghost.style.width = r.width + 'px';
                ghost.style.height = r.height + 'px';
                document.body.appendChild(ghost);
                chip.classList.add('uris-dragging');
                document.body.classList.add('uris-dragging-active');
            }
            ghost.style.transform = `translate(${ev.clientX - grabX}px, ${ev.clientY - grabY}px)`;
            const zone = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-drop-zone]') || null;
            if (zone !== overZone) {
                overZone?.classList.remove('uris-drop-zone--over');
                overZone = zone;
                overZone?.classList.add('uris-drop-zone--over');
            }
        };
        const finish = (ev) => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', finish);
            document.removeEventListener('pointercancel', finish);
            if (ghost) ghost.remove();
            chip.classList.remove('uris-dragging');
            document.body.classList.remove('uris-dragging-active');
            overZone?.classList.remove('uris-drop-zone--over');
            const zone = dragging && ev
                ? (document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-drop-zone]') || null)
                : null;
            overZone = null;
            if (zone) onDrop(refId);
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', finish);
        document.addEventListener('pointercancel', finish);
    });
}

async function resolveCurrentRootReferences(root) {
    const ctx = getCtx();
    const msgId = state.currentMsgId;
    if (msgId == null) return null;
    const messageText = ctx.chat?.[msgId]?.mes || '';
    const draft = await getGenerationDraft(ctx.chatId, msgId, messageText);
    return await resolveDraftPromptReferences(ctx.chatId, draft);
}

async function getSnapshotReferencePolicy(snapshot, loadConnection = getConnection) {
    const route = snapshot?.imageRoute;
    const imageProfileId = snapshot?.imageProfileId ?? null;
    const conn = imageProfileId ? await loadConnection(imageProfileId) : null;
    const base = route
        ? resolveConnectionReferencePolicy({ selectedRoute: route })
        : conn
            ? resolveConnectionReferencePolicy(conn)
            : { supported: false, maxRefs: 0, reason: 'Image-коннект не выбран.' };
    // Decorate with how references actually travel on the wire, and — when the
    // gateway already rejected them once — the next dialect in the fallback
    // chain worth trying (one click pins it as an override; never automatic).
    const encoding = route?.generationContract ? referenceEncoding(route.generationContract) : null;
    const modelId = route?.modelId || null;
    const evidence = modelId && conn?.evidence?.[modelId] ? conn.evidence[modelId] : null;
    const out = { ...base, ...(encoding ? { encoding } : {}) };
    if (conn && modelId && evidence?.refs === 'rejected' && base.supported) {
        const plan = resolveDispatchPlan(conn);
        const chain = plan?.alternatives || [];
        const currentDialect = route?.generationContract || plan?.dialect || null;
        const index = currentDialect ? chain.indexOf(currentDialect) : -1;
        const next = index >= 0 ? chain[index + 1] : chain[0];
        out.rejected = {
            reason: evidence.reason || 'шлюз отклонил референсы',
            dialect: currentDialect,
            nextDialect: next || null,
        };
    }
    return out;
}

export { getSnapshotReferencePolicy };

async function getActiveReferencePolicy() {
    const snapshot = await resolveChatConfigSnapshot();
    return getSnapshotReferencePolicy(snapshot);
}

/**
 * Live preview of the references that the current prompt will send to Stage2.
 * @param {HTMLElement} root
 * @param {import('../scene-context.js').SceneContextSnapshot|null} referenceResolution
 */
export async function renderLivePreview(root, referenceResolution) {
    const host = root.querySelector('#urisRefsPreview');
    if (!host) return;
    const refs = referenceResolution?.stage2Refs || [];
    const effectiveIds = new Set(refs.map(r => r.id));
    const policy = await getActiveReferencePolicy();
    const panelState = buildReferencePanelState(refs, policy);
    const capLabel = `<div class="uris-refs-stage2-cap">Выбрано для генерации  ·  ${panelState.unsupported ? escapeHtml(panelState.message) : `${panelState.count}/${panelState.max === null ? 'без заявленного лимита' : panelState.max}${policy.encoding ? ` · ${escapeHtml(policy.encoding)}` : ''}`}</div>`;
    const chips = renderReferencePreviewMarkup(refs);
    const promptText = root.querySelector('#urisPrompt')?.value?.trim() || '';
    const isEmpty = refs.length === 0 && panelState.canAdd && promptText.length > 0;
    const addTitle = isEmpty ? 'Добавить референс (промпт никого не упомянул)' : 'Добавить референс в генерацию';
    const addTile = panelState.canAdd
        ? `<button class="uris-refs-add-tile" title="${addTitle}" aria-label="${addTitle}"><i class="fa-solid fa-plus"></i></button>`
        : '';
    const policyInfo = panelState.unsupported || panelState.overLimit
        ? `<small class="uris-refs-policy-info${panelState.overLimit ? ' uris-warning' : ''}">${escapeHtml(panelState.message)}</small>`
        : '';
    const rejectedHint = policy.rejected
        ? `<div class="uris-refs-policy-info uris-warning">Шлюз отклонил референсы через ${escapeHtml(policy.rejected.dialect || 'текущий протокол')} (${escapeHtml(policy.rejected.reason)}).${policy.rejected.nextDialect
            ? ` <button type="button" class="uris-refs-dialect-switch" data-next-dialect="${escapeHtml(policy.rejected.nextDialect)}" title="Закрепить ${escapeHtml(policy.rejected.nextDialect)} как протокол этого коннекта">Попробовать ${escapeHtml(policy.rejected.nextDialect)}</button>`
            : ' Другие протоколы для этого шлюза не известны — проверьте настройки коннекта.'}</div>`
        : '';
    host.innerHTML = `${capLabel}<div class="uris-refs-strip">${chips}${addTile}</div>${policyInfo}${rejectedHint}`;

    host.querySelector('.uris-refs-dialect-switch')?.addEventListener('click', async event => {
        const nextDialect = event.target?.dataset?.nextDialect;
        const snapshot = await resolveChatConfigSnapshot();
        const connId = snapshot.imageProfileId;
        if (!nextDialect || !connId) return;
        try {
            const conn = await getConnection(connId);
            await saveConnection({ id: connId, overrides: { ...(conn?.overrides || {}), dialect: nextDialect } });
            toastr?.info(`Протокол коннекта закреплён: ${nextDialect}`);
            refreshActive();
        } catch (e) {
            recordUrisError({ scope: 'Параметры', message: 'Не удалось сменить протокол: ' + (e?.message || e) });
            toastr?.error('Не удалось сменить протокол: ' + (e?.message || e));
        }
    });

    host.querySelector('.uris-refs-add-tile')?.addEventListener('click', async () => {
        const chosen = await showPoolPicker({ title: 'Референсы для генерации', multi: true, excludeIds: Array.from(effectiveIds) });
        if (!chosen?.length) return;
        await addStage2Includes(root, chosen);
    });
}

/**
 * Cap warning: effective ref count over the hard limit or unsupported provider.
 * @param {HTMLElement} root
 * @param {import('../scene-context.js').SceneContextSnapshot|null} referenceResolution
 */
async function renderCap(root, referenceResolution = null) {
    const cap = root.querySelector('#urisRefsCap');
    if (!cap) return;

    const refs = referenceResolution?.stage2Refs || [];
    const policy = await getActiveReferencePolicy();
    const panelState = buildReferencePanelState(refs, policy);

    // Cap indicator N/M (primary in renderLivePreview; here as fallback/legacy host).
    cap.textContent = panelState.unsupported ? panelState.message : `${panelState.count}/${panelState.max}`;
    cap.hidden = false;
}

function updatePostInfo(root) {
    const info = root.querySelector('#urisPostInfo');
    if (!info) return;
    info.textContent = getPostInfo();
    // The reference panel is refreshed on post change — smart-matching
    // depends on the current message text. refreshReferencePanel is async;
    // it does not block the UI (fire-and-forget).
    refreshReferencePanel(root);
}

/**
 * Update the queue status text displayed in the Generate tab.
 * Renders a «Остановить» button while the queue has pending/running work so
 * the already-imported stopQueue() is reachable from the UI (it aborts the
 * shared queue controller and every active generation).
 * @param {HTMLElement} root
 */
export function updateQueueStatus(root) {
    const el = root.querySelector('#urisQueueStatus');
    if (!el) return;
    const n = state.queue.length;
    if (n || state.queueRunning) {
        // «Пропустить» is shown only while a specific queue item is in flight
        // (runningQueueRequestId, tracked via the uris:stage2-start/end events);
        // it cancels just that item, so the queue continues with the next one.
        const skipBtn = state.runningQueueRequestId
            ? ` <button type="button" class="uris-queue-skip" id="urisSkipItem" title="Отменить текущую задачу и продолжить очередь">Пропустить</button>`
            : '';
        el.innerHTML = `<span>В очереди: ${n}</span> <button type="button" class="uris-queue-stop" id="urisStopQueue" title="Остановить все задачи очереди">Остановить</button>${skipBtn}`;
        el.querySelector('#urisStopQueue')?.addEventListener('click', () => {
            stopQueue();
            updateQueueStatus(root);
        });
        el.querySelector('#urisSkipItem')?.addEventListener('click', () => {
            if (state.runningQueueRequestId) abortGeneration(state.runningQueueRequestId);
        });
    } else {
        el.textContent = '';
    }
}

/**
 * Toggle the in-flight "Остановить" button without a full re-render. Only the
 * button's visibility and data-request-id are touched: input disabled states
 * are left to the normal render cycle (withBusy already prevents a double
 * submit, and locking the editor mid-generation was never the original
 * behaviour).
 * @param {HTMLElement|null} root
 * @param {string|null} requestId
 * @param {boolean} running
 */
export function setCancelState(root, requestId, running) {
    const btn = root?.querySelector?.('#urisCancelImage');
    if (!btn) return;
    btn.hidden = !running;
    if (running && requestId) btn.setAttribute('data-request-id', String(requestId));
}

// Singleton window listeners for the Stage 1/2 lifecycle. The pipeline drives
// the "Остановить" button (and queue status) from one place, so manual, auto
// and queue generations all show/hide it uniformly instead of each call site
// re-rendering the tab.
let _abortUIBound = false;
let _onStage2Start = null;
let _onStage2End = null;
let _onStage1Start = null;
let _onStage1End = null;
// msgId → requestId of the latest in-flight generation (Stage 1 or 2). Source
// of truth for syncCancelState: a tab re-render rebuilds the button DOM and
// would otherwise lose the in-flight state.
const _runningByMsgId = new Map();

/** Shared uris:stage{1,2}-start handling: show the Stop button, tag the queue item. */
function onGenerationStart(ev) {
    const detail = /** @type {CustomEvent} */ (ev).detail || {};
    const { requestId, msgId, source } = detail;
    if (!requestId) return;
    if (source === 'queue') state.runningQueueRequestId = requestId;
    if (msgId != null) _runningByMsgId.set(msgId, requestId);
    if (_generateRoot && msgId === state.currentMsgId) {
        setCancelState(_generateRoot, requestId, true);
    }
    if (_generateRoot) updateQueueStatus(_generateRoot);
}

/** Shared uris:stage{1,2}-end handling: hide the Stop button only if it still points at this request. */
function onGenerationEnd(ev) {
    const detail = /** @type {CustomEvent} */ (ev).detail || {};
    const { requestId, msgId } = detail;
    if (!requestId) return;
    if (state.runningQueueRequestId === requestId) state.runningQueueRequestId = null;
    if (msgId != null && _runningByMsgId.get(msgId) === requestId) _runningByMsgId.delete(msgId);
    if (_generateRoot) {
        const btn = _generateRoot.querySelector('#urisCancelImage');
        if (btn && btn.getAttribute('data-request-id') === String(requestId)) {
            setCancelState(_generateRoot, null, false);
        }
        updateQueueStatus(_generateRoot);
    }
}

/**
 * Re-apply the in-flight "Остановить" state after a tab re-render. Rendering
 * rebuilds the button DOM (losing data-request-id / hidden state), so the
 * running map is what tells whether a generation is in flight for the current
 * post; without this a re-render mid-generation hides the button and unlocks
 * the action buttons.
 * @param {HTMLElement} root
 */
export function syncCancelState(root) {
    const requestId = state.currentMsgId != null ? _runningByMsgId.get(state.currentMsgId) : undefined;
    setCancelState(root, requestId, Boolean(requestId));
    updateQueueStatus(root);
}

export function bindAbortUI() {
    if (_abortUIBound || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    _onStage1Start = onGenerationStart;
    _onStage1End = onGenerationEnd;
    _onStage2Start = onGenerationStart;
    _onStage2End = onGenerationEnd;
    window.addEventListener('uris:stage1-start', _onStage1Start);
    window.addEventListener('uris:stage1-end', _onStage1End);
    window.addEventListener('uris:stage2-start', _onStage2Start);
    window.addEventListener('uris:stage2-end', _onStage2End);
    _abortUIBound = true;
}

export function unbindAbortUI() {
    if (!_abortUIBound) return;
    if (_onStage1Start) window.removeEventListener('uris:stage1-start', _onStage1Start);
    if (_onStage1End) window.removeEventListener('uris:stage1-end', _onStage1End);
    if (_onStage2Start) window.removeEventListener('uris:stage2-start', _onStage2Start);
    if (_onStage2End) window.removeEventListener('uris:stage2-end', _onStage2End);
    _onStage1Start = null;
    _onStage1End = null;
    _onStage2Start = null;
    _onStage2End = null;
    _runningByMsgId.clear();
    _abortUIBound = false;
}
