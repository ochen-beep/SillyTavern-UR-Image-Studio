// @ts-check
/**
 * Generation tab v3: prompt-first editor over message-scoped draft.
 * Layout: post-navigator, excerpt/stale badge, prompt editor, actions Stage 1 / Stage 2,
 * compact aspect/size/quality controls, references panel, Advanced (template/automation/queue).
 */
import { state, getCtx, escapeHtml, error, warn, VALID_ASPECT_RATIOS, VALID_IMAGE_SIZES, abortGeneration } from '../core.js';
import { notifyStage1Ready } from '../events.js';
import { POST_FILTER, navigatePosts, getPostInfo, setFilter, setCurrentMsgId, getLastPostIndex } from '../post-navigator.js';
import { runStage1ForDraft, enqueueGeneration, createQueueItem, buildCandidates } from '../pipeline.js';
import { getGenerationDraft, updateGenerationDraft, hashMessage, normalizeTemplateSelection, resolveDraftTemplateId, noteLiveGenerationParams, getLiveGenerationParams } from '../generation-drafts.js';
import { listTemplates, getTemplate } from '../prompt-templates.js';
import { resolveSTMacros } from '../template-runtime.js';
import { patchChatConfig, loadChatConfig } from '../chat-binding.js';
import { getActiveTab, refreshActive } from './tabs.js';
import { getRefSync } from '../refs-library.js';
import { showSingleImage } from './lightbox.js';
import { editTextModal } from './text-editor.js';
import { resolveChatConfigSnapshot } from '../pipeline-config.js';
import { getConnection } from '../connections.js';
import {
    detectModelFamily,
    VALID_PARAMS,
    getVisibleModelChoices,
    classifyModelCapability,
} from '../dispatch-plan.js';
import { reportFailure, URIS_SCOPES } from '../error-pool.js';
import { isStudioActive, STUDIO_CHAT_ID, STUDIO_MSG_ID } from '../studio-scope.js';

import { activeScope, setGenerateRoot, getGenerateRoot } from './tab-generate-scope.js';
import {
    updateReferenceCorrections,
    buildReferencePanelState,
    resolveConnectionReferencePolicy,
    renderReferencePreviewMarkup,
    renderPromptAmbiguities,
    renderAmbiguitiesMarkup,
    renderMatchedKeywords,
    renderLivePreview,
    refreshReferencePanel,
    resolveDraftPromptReferences,
    applyReferenceCorrection,
    addStage2Includes,
    getSnapshotReferencePolicy,
} from './tab-generate-refs.js';
import { setCancelState, syncCancelState, bindAbortUI, unbindAbortUI } from './generation-lifecycle-ui.js';

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
    // The studio scene text is an editable input, not a source message — there
    // is no "original" it could drift from, so the stale badge never applies.
    const isStale = normalizedDraft.chatId !== STUDIO_CHAT_ID
        && normalizedDraft.messageHash !== currentHash;
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
 * Render the Generate tab markup from a view model.
 *
 * @param {ReturnType<buildGenerateViewModel>} vm
 * @returns {string}
 */
export function renderGenerateMarkup(vm) {
    const { draft, templates, isStale, stage1Action, canGenerateImage, isRunning, stage2RequestId, stage1Error, stage2Error, ambiguities, entities } = vm;
    const isStudio = vm.isStudio === true;
    const excerpt = escapeHtml((vm.messageText || '').slice(0, 120));
    const staleBadge = isStale ? '<span class="uris-draft-stale">исходное сообщение изменилось</span>' : '';
    // The editor and action buttons are never disabled by generation state —
    // submissions are fire-and-forget; isRunning only drives the Stop button
    // visibility below.
    const generateDisabledAttr = !canGenerateImage ? ' disabled' : '';
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
    const followOn = state.settings.followLastPost !== false;
    const followActiveClass = followOn ? ' is-active' : '';
    const followPressed = followOn ? 'true' : 'false';

    // Stage 1/2 errors are no longer rendered as a red inline block — they
    // live in the header error pool (reportFailure from the action handlers).

    // Source block: in a chat it is the read-only excerpt of the selected post;
    // in the studio the scene text is an input the user edits freely.
    const sourceBlock = isStudio
        ? `
            <div class="uris-context-box uris-studio-scene">
                <textarea class="text_pole uris-scene-area" id="urisScene" rows="3" placeholder="Текст сцены — по нему распознаются референсы. Можно оставить пустым и написать промпт напрямую.">${escapeHtml(vm.messageText || '')}</textarea>
                <div class="uris-scene-context">${ambiguityList}</div>
            </div>`
        : `
            <div class="uris-context-box">
                <div class="uris-source-excerpt">${excerpt}${staleBadge}</div>
                <div class="uris-scene-context">${ambiguityList}</div>
            </div>`;

    // Header: post navigator in a chat, a static studio badge on the welcome
    // screen (post navigation is meaningless there).
    const headerBlock = isStudio
        ? `
            <div class="uris-postnav">
                <div class="uris-postnav-info" id="urisPostInfo" title="Генерация без открытого чата">Студия — генерация вне чата</div>
            </div>`
        : `
            <div class="uris-postnav">
                <button class="uris-postnav-btn" id="urisPrev" title="Предыдущий пост" type="button" aria-label="Предыдущий пост"><i class="fa-solid fa-chevron-left"></i></button>
                <div class="uris-postnav-info" id="urisPostInfo" title="Текущий пост">—</div>
                <button class="uris-postnav-btn" id="urisNext" title="Следующий пост" type="button" aria-label="Следующий пост"><i class="fa-solid fa-chevron-right"></i></button>
                <button class="uris-postnav-btn uris-follow-toggle${followActiveClass}" id="urisFollowLast"
                    title="Следить за последним постом" aria-pressed="${followPressed}" type="button">
                    <i class="fa-solid fa-magnet"></i>
                </button>
            </div>`;

    // Automation and message-flow selectors need chat messages to ever fire —
    // they are hidden in the studio (the studio envelope keeps their defaults).
    const chatOnlyParams = isStudio ? '' : `
                <span class="uris-param"><span class="uris-param-label">Автоматизация</span>
                    <select class="text_pole" id="urisAutomationMode">
                        <option value="manual" ${vm.automationMode === 'manual' ? 'selected' : ''}>Вручную</option>
                        <option value="build-prompt" ${vm.automationMode === 'build-prompt' ? 'selected' : ''}>Строить промпт</option>
                        <option value="full-pipeline" ${vm.automationMode === 'full-pipeline' ? 'selected' : ''}>Полный pipeline</option>
                    </select></span>
                <span class="uris-param"><span class="uris-param-label">Флоу генерации</span>
                    <select class="text_pole" id="urisGenerationFlow">
                        <option value="${POST_FILTER.AI_ONLY}" ${state.chatGenerationFlow === POST_FILTER.AI_ONLY ? 'selected' : ''}>Только AI</option>
                        <option value="${POST_FILTER.USER_ONLY}" ${state.chatGenerationFlow === POST_FILTER.USER_ONLY ? 'selected' : ''}>Только пользователь</option>
                        <option value="${POST_FILTER.ALL}" ${state.chatGenerationFlow === POST_FILTER.ALL ? 'selected' : ''}>Все сообщения</option>
                        <option value="${POST_FILTER.MANUAL}" ${state.chatGenerationFlow === POST_FILTER.MANUAL ? 'selected' : ''}>Ручной выбор</option>
                    </select></span>`;

    return `
        <div class="uris-gen">
            ${headerBlock}
            ${sourceBlock}

            <div class="uris-prompt-card">
                <textarea class="text_pole uris-prompt-area" id="urisPrompt" rows="6" placeholder="Промпт картинки">${escapeHtml(draft.prompt || '')}</textarea>
                <button class="uris-expand-btn" id="urisPromptExpand" type="button" title="Развернуть редактор" aria-label="Развернуть редактор"><i class="fa-solid fa-maximize"></i></button>
                <div class="uris-gen-actions">
                    <button class="uris-btn uris-btn-ghost" id="urisBuildPrompt" type="button">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> ${stage1Label}
                    </button>
                    <button class="uris-btn uris-btn-ghost" id="urisInsertTemplate" type="button" title="Вставить инструкцию шаблона, выбранного в списке «Шаблон», в промпт"><i class="fa-solid fa-file-import"></i> Вставить шаблон</button>
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
                ${chatOnlyParams}
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
                <div class="uris-refs-sources-section">
                    <div class="uris-refs-sources-label">Whitelist референсов</div>
                    <div class="uris-refs-panel-extras" id="urisRefsWhitelist"></div>
                </div>
            </div>
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

// Quality values that survive the wire, per model family. Read from
// dispatch-plan so the Select and the provider adapter share one table — a local
// copy is exactly how two dall-e options ended up dead (offered here, rejected
// there with a warning). The tie is enforced by the contract test in
// tests/image-provider-adapters.test.js.
const QUALITY_BY_FAMILY = VALID_PARAMS.quality;

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
            await patchChatConfig({ generationDefaults: { modelId } });
            state.generationDefaults = { ...(state.generationDefaults || {}), modelId };
            const scope = activeScope(root);
            if (scope.studio || (scope.msgId != null && ctx.chat?.[scope.msgId])) {
                const params = readGenerationParams(root, {});
                await updateGenerationDraft(scope.chatId, scope.msgId, scope.messageText, d => ({
                    ...d,
                    prompt: root.querySelector('#urisPrompt')?.value || '',
                    ...params,
                }));
            }
            options.onSwitched?.(modelId);
        } catch (e) {
            reportFailure({ scope: URIS_SCOPES.params, message: `Не удалось сменить модель: ${e?.message || e}`, toast: true });
        }
    });
}

/**
 * Render the Generate tab UI into the given root element.
 * @param {HTMLElement} root
 */
export async function render(root) {
    setGenerateRoot(root);
    // Bump the epoch on every render call, including the direct render(root) calls
    // from bindings (post navigation, reference corrections, model switch) that
    // never pass through the tab-switch entry point. Without the bump two
    // concurrent direct renders share one epoch, and the slower stale render
    // overwrites the DOM of the fresher one — the editor then shows a different
    // post than state.currentMsgId points at.
    root.__urisRenderEpoch = (root.__urisRenderEpoch || 0) + 1;
    const renderEpoch = root.__urisRenderEpoch;
    const isCurrent = () => root.__urisRenderEpoch === renderEpoch && root.__urisTabId === 'generate';
    const ctx = getCtx();
    const studio = isStudioActive();
    const chatId = studio ? STUDIO_CHAT_ID : ctx.chatId;
    const msgId = studio ? STUDIO_MSG_ID : state.currentMsgId;

    // Guard: if no chat is open or no valid msgId exists (e.g., initialization
    // before CHAT_CHANGED), render the empty state instead of calling
    // getGenerationDraft(chatId, null, ...) — generationDraftKey throws,
    // async-render rejects, and the tab stays blank.
    if (!studio && (!chatId || msgId == null || !ctx.chat?.[msgId])) {
        root.innerHTML = renderEmptyStateMarkup();
        bindEmptyState(root);
        return;
    }

    // Studio: the draft comes first — the scene text is an editable input that
    // lives inside the draft, not an immutable source message.
    const draft = studio
        ? await getGenerationDraft(chatId, msgId, '')
        : await getGenerationDraft(chatId, msgId, ctx.chat[msgId].mes || '');
    if (!isCurrent()) return;
    const messageText = studio ? (draft.sceneText || '') : (ctx.chat[msgId].mes || '');
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
        // Свежий выбор пользователя важнее перечитанного chat-конфига (пункт
        // 1.1): patchChatConfig ещё в полёте, и старый дефолт с сервера не
        // должен перебить то, что пользователь выставил секунду назад.
        ...composeEffectiveParams(draft, defaults, getLiveGenerationParams(chatId, msgId, messageText)),
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
        automationMode: state.chatAutomationMode,
        templates,
        messageText,
        activeTemplateId: state.activeTemplateId,
    });

    // resolveModelChoices may throw (assertImageModelEligible in the config
    // snapshot: the chat's saved model was reclassified as non-image by fresh
    // catalog metadata). Letting it reject the render leaves a silently empty
    // tab — tabs.js swallows render rejections. Degrade to the "no connection"
    // select and surface the reason instead.
    let modelChoices = null;
    try {
        modelChoices = await resolveModelChoices();
    } catch (e) {
        error('Generate tab: model choices failed:', e?.message || e);
        reportFailure({ scope: URIS_SCOPES.params, message: `Модель чата недоступна: ${e?.message || e}`, toast: true });
    }
    if (!isCurrent()) return;
    root.innerHTML = renderGenerateMarkup({ ...vm, modelChoices, qualityOptions: qualityOptionsFor(modelChoices?.current || '', effectiveDraft.quality), isStudio: studio });
    bindGenerate(root);
    syncCancelState(root);
    bindModelSelect(root, modelChoices, { onSwitched: () => render(root) });
    if (!studio) updatePostInfo(root);
    refreshReferencePanel(root, referenceResolution, snapshot);
}

// ── Bindings ──

/**
 * Итоговые параметры панели: черновик → chat-дефолты → живой выбор UI.
 * Живой оверлей (пункт 1.1) имеет высший приоритет: свежее действие
 * пользователя старше перечитанного chat-конфига, чей patchChatConfig ещё
 * может быть в полёте.
 * @param {{aspectRatio:string,imageSize:string,quality:string}} draft
 * @param {{aspectRatio?:string|null,imageSize?:string|null,quality?:string|null}|null} defaults
 * @param {{aspectRatio?:string,imageSize?:string,quality?:string}|null} liveParams
 * @returns {{aspectRatio:string,imageSize:string,quality:string}}
 */
export function composeEffectiveParams(draft, defaults, liveParams) {
    return {
        aspectRatio: defaults?.aspectRatio || draft.aspectRatio,
        imageSize: defaults?.imageSize || draft.imageSize,
        quality: defaults?.quality || draft.quality,
        ...(liveParams || {}),
    };
}

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

/**
 * Splice inserted text into a prompt string at the editor caret, adding newline
 * separation so the insert never glues onto existing lines. A missing caret
 * (elements without selectionStart, e.g. fake-dom) appends at the end.
 * @param {string} value
 * @param {string} text
 * @param {{start?:number,end?:number}} [caret]
 * @returns {string}
 */
export function composeInsertedPrompt(value, text, caret = {}) {
    const source = String(value ?? '');
    const clamp = n => Math.max(0, Math.min(n, source.length));
    const start = Number.isInteger(caret.start) ? clamp(caret.start) : source.length;
    const end = Number.isInteger(caret.end) ? clamp(Math.max(caret.end, start)) : start;
    const before = source.slice(0, start);
    const after = source.slice(end);
    const lead = before && !before.endsWith('\n') ? '\n' : '';
    const trail = after && !after.startsWith('\n') ? '\n' : '';
    return before + lead + text + trail + after;
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

/**
 * Bind all Generate tab event listeners to the rendered root.
 * @param {HTMLElement} root
 */
export function bindGenerate(root) {
    // Post navigator — re-render the whole tab on navigation so the draft switches.
    // Absent in the studio (no posts to navigate).
    root.querySelector('#urisPrev')?.addEventListener('click', () => { navigatePosts(-1); render(root); });
    root.querySelector('#urisNext')?.addEventListener('click', () => { navigatePosts(1); render(root); });

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

    // Studio scene text: editable Stage 1 source. Autosaved into the draft
    // (sceneText) and refreshes the prompt-driven reference preview live.
    const sceneEl = root.querySelector('#urisScene');
    if (sceneEl) {
        const sceneAutosave = createCancellablePromptAutosave({
            persist: async ({ value }) => {
                const scope = activeScope(root);
                const savedDraft = await updateGenerationDraft(scope.chatId, scope.msgId, scope.messageText, d => ({
                    ...d,
                    sceneText: value,
                }));
                if (isStudioActive()) {
                    const resolution = await resolveDraftPromptReferences(scope.chatId, savedDraft);
                    renderMatchedKeywords(root, undefined, resolution);
                    await renderLivePreview(root, resolution);
                    renderPromptAmbiguities(root, resolution);
                }
            },
        });
        sceneEl.addEventListener('input', () => {
            sceneAutosave.schedule({ value: sceneEl.value });
        });
    }

    // Prompt autosave: editing sets origin to manual and refreshes the prompt-driven preview.
    // Identity (chatId/msgId) and text are captured at INPUT time into the scheduled payload:
    // a pending save must land in the draft of the post being edited, never in whatever post
    // the user navigated to while the debounce was pending (re-reading state.currentMsgId in
    // the callback wrote the stale textarea text across posts and chats).
    const promptEl = root.querySelector('#urisPrompt');
    const autosave = createCancellablePromptAutosave({
        persist: async ({ chatId, msgId, messageText, value }) => {
            const savedDraft = await updateGenerationDraft(chatId, msgId, messageText, d => ({
                ...d,
                prompt: value,
                promptOrigin: d.prompt ? 'manual' : d.promptOrigin,
            }));
            // Only refresh if the user is still editing the same draft.
            const scope = activeScope(root);
            if (scope.chatId === chatId && scope.msgId === msgId) {
                const resolution = await resolveDraftPromptReferences(chatId, savedDraft);
                renderMatchedKeywords(root, undefined, resolution);
                await renderLivePreview(root, resolution);
                renderPromptAmbiguities(root, resolution);
            }
        },
    });
    promptEl?.addEventListener('input', () => {
        const scope = activeScope(root);
        syncGenerateEnabled(root);
        autosave.schedule({
            chatId: scope.chatId,
            msgId: scope.msgId,
            messageText: scope.messageText,
            value: promptEl.value,
        });
    });

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

    // Insert the selected template's instruction into the prompt editor as plain
    // editable text (macros expanded — raw {{char}} placeholders must not reach
    // the image model). The synthetic input event reuses the autosave +
    // live-preview + enable pipeline, same as the expanded editor above.
    root.querySelector('#urisInsertTemplate')?.addEventListener('click', async () => {
        if (!promptEl) return;
        const templateId = root.querySelector('#urisTemplate')?.value || '';
        if (!templateId) {
            toastr?.warning('Шаблон не выбран — выберите шаблон в списке «Шаблон»');
            return;
        }
        const template = await getTemplate(templateId);
        if (!template) {
            toastr?.warning('Шаблон не найден — обновите список на вкладке «Шаблоны»');
            return;
        }
        const instruction = String(template.instruction || '').trim();
        if (!instruction) {
            toastr?.warning('Инструкция шаблона пуста — нечего вставлять');
            return;
        }
        promptEl.value = composeInsertedPrompt(promptEl.value, resolveSTMacros(instruction), {
            start: promptEl.selectionStart,
            end: promptEl.selectionEnd,
        });
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
            const src = img?.getAttribute('src');
            if (chip && src) {
                const ref = getRefSync(chip.dataset.refId);
                if (ref?.imagePath) {
                    showSingleImage({
                        src: ref.imagePath,
                        width: ref.width,
                        height: ref.height,
                        actions: 'ref',
                        refId: ref.id,
                        name: ref.name,
                        aliases: ref.aliases,
                        description: ref.description,
                    });
                } else {
                    showSingleImage({ src, prompt: chip.title || '' });
                }
            }
            return;
        }
        const chipEl = btn.closest('.uris-ref-chip-preview');
        const refId = chipEl?.dataset.refId;
        if (!refId) return;
        await applyReferenceCorrection(root, refId, false);
    });

    // Stage 1 always builds or rebuilds the prompt independently of Stage 2.
    const buildPromptButton = root.querySelector('#urisBuildPrompt');
    buildPromptButton?.addEventListener('click', withBusy(buildPromptButton, async () => {
        try {
            const input = await prepareSubmissionInput(root);
            if (!input) return;
            const run = await runStage1ForDraft(input);
            if (run.applied) {
                notifyStage1Ready(run.draft.prompt);
                toastr?.success('Промпт построен');
            }
        } catch (e) {
            error('Generate action:', e.message);
            reportFailure({ scope: URIS_SCOPES.stage1, message: e.message, context: input ? { post: input.msgId } : null, toast: true });
        }
        await render(root);
    }));

    // Stage 2 is fire-and-forget: snapshot the visible state, enqueue, return.
    // withBusy only guards the (fast) snapshot+enqueue part against a literal
    // double-click; the editor and buttons stay live for the whole generation.
    const generateImageButton = root.querySelector('#urisGenerateImage');
    generateImageButton?.addEventListener('click', withBusy(generateImageButton, () => submitCurrentGeneration(root)));

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
        const scope = activeScope(root);
        const ctx = getCtx();
        if (scope.studio || (scope.msgId != null && ctx.chat?.[scope.msgId])) {
            await updateGenerationDraft(scope.chatId, scope.msgId, scope.messageText, d => ({ ...d, [key]: value || d[key] }));
        }
    };
    for (const [selector, key] of [['#urisAspect', 'aspectRatio'], ['#urisImgSize', 'imageSize'], ['#urisQuality', 'quality']]) {
        root.querySelector(selector)?.addEventListener('change', async e => {
            try {
                // В живой оверлей ДО любого await (пункт 1.1): перерендер в окне
                // записи должен увидеть ровно это значение, а не перечитанный
                // старый черновик.
                const scope = activeScope(root);
                if (scope.studio || (scope.msgId != null && getCtx().chat?.[scope.msgId])) {
                    noteLiveGenerationParams(scope.chatId, scope.msgId, scope.messageText, { [key]: e.target.value });
                }
                await saveGenerationDefault(key, e.target.value);
            } catch (e) {
                reportFailure({ scope: URIS_SCOPES.params, message: `Не удалось сохранить ${key}: ${e?.message || e}`, toast: true, toastText: `Не удалось сохранить параметр: ${e?.message || e}` });
            }
        });
    }

    // Generation flow selector — chat-scoped (schema-v5 config), never the
    // globally persisted settings: the last visited chat must not become the
    // next session's startup default for every other chat.
    root.querySelector('#urisGenerationFlow')?.addEventListener('change', async e => {
        const flow = e.target.value;
        state.chatGenerationFlow = flow;
        setFilter(flow);
        await patchChatConfig({ generationFlow: flow });
    });

    // Automation mode selector — chat-scoped, same as above.
    root.querySelector('#urisAutomationMode')?.addEventListener('change', async e => {
        const mode = e.target.value;
        state.chatAutomationMode = mode;
        await patchChatConfig({ automationMode: mode });
    });

    // Template is a chat-wide default. Keep legacy draft override fields aligned
    // for old consumers, but make the metadata choice authoritative for new runs.
    root.querySelector('#urisTemplate')?.addEventListener('change', async () => {
        const templateId = root.querySelector('#urisTemplate')?.value || null;
        try {
            await patchChatConfig({ templateId });
            state.activeTemplateId = templateId;
            const scope = activeScope(root);
            if (scope.studio || (scope.msgId != null && getCtx().chat?.[scope.msgId])) {
                await updateGenerationDraft(scope.chatId, scope.msgId, scope.messageText, d => ({
                    ...d,
                    templateSelection: 'default',
                    templateId: null,
                }));
            }
        } catch (e) {
            reportFailure({ scope: URIS_SCOPES.params, message: `Не удалось сохранить шаблон: ${e?.message || e}`, toast: true });
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
 * Live state of the «Сгенерировать» button: an empty prompt keeps it disabled,
 * a non-empty one enables it — without waiting for a tab re-render (render
 * sets disabled from the draft at render time only).
 * @param {HTMLElement|null} root
 */
export function syncGenerateEnabled(root) {
    const btn = root?.querySelector?.('#urisGenerateImage');
    const promptEl = root?.querySelector?.('#urisPrompt');
    if (!btn || !promptEl) return;
    btn.disabled = !String(promptEl.value || '').trim();
}

/**
 * Build the Stage 1/2 run input AND the submit-time submission snapshot from
 * the visible editor state. The snapshot is what a queued Stage 2 will send:
 * later edits belong to the next submission and must not leak into this one.
 * @param {HTMLElement} root
 * @returns {Promise<object|null>} null when there is no post to submit for
 */
export async function prepareSubmissionInput(root) {
    const chatConfig = await resolveChatConfigSnapshot();
    const scope = activeScope(root);
    if (!scope.studio && scope.msgId == null) {
        toastr?.warning('Нет поста');
        return null;
    }
    const promptEl = root.querySelector('#urisPrompt');
    const currentDraft = await getGenerationDraft(scope.chatId, scope.msgId, scope.messageText);
    const templateId = resolveDraftTemplateId(currentDraft, state.activeTemplateId);
    const params = readGenerationParams(root, currentDraft);
    const prompt = promptEl?.value || '';
    const savedDraft = await updateGenerationDraft(scope.chatId, scope.msgId, scope.messageText, d => ({
        ...d,
        // Flush the visible scene text with the run: a pending debounced
        // autosave must not miss it.
        ...(scope.studio ? { sceneText: scope.messageText } : {}),
        prompt,
        ...params,
    }));
    return {
        chatId: scope.chatId,
        msgId: scope.msgId,
        messageText: scope.messageText,
        templateId,
        chatConfig,
        submission: {
            prompt,
            ...params,
            references: {
                includedIds: [...(savedDraft.references?.includedIds || [])],
                excludedIds: [...(savedDraft.references?.excludedIds || [])],
                revision: savedDraft.references?.revision || 0,
            },
        },
    };
}

/**
 * Fire-and-forget Stage 2 submission: snapshot the visible editor state, put it
 * on the serial queue, and return. The editor is never locked for the duration
 * of a generation — completion is reported via toasts and the queue status line.
 * @param {HTMLElement} root
 * @param {{enqueue?:Function}} [deps] - enqueue injection for tests
 */
export async function submitCurrentGeneration(root, deps = {}) {
    const enqueueFn = deps.enqueue || enqueueGeneration;
    try {
        const input = await prepareSubmissionInput(root);
        if (!input) return;
        if (!input.submission.prompt.trim()) {
            toastr?.warning('Промпт пуст — постройте или напишите промпт');
            return;
        }
        const item = await createQueueItem({
            chatId: input.chatId,
            msgId: input.msgId,
            messageText: input.messageText,
            requestedAction: 'current-prompt-stage2',
            templateId: input.templateId,
            submission: input.submission,
        });
        // Read after the await so the busy check reflects the queue state at
        // enqueue time, not before the submission snapshot was resolved.
        const wasBusy = state.queueRunning || state.queue.length > 0;
        const queued = enqueueFn(item);
        toastr?.info(wasBusy ? 'Добавлено в очередь' : 'Генерация началась');
        queued.then(entry => {
            if (!entry) return;
            toastr?.success('Картинка сгенерирована');
            // Provider warnings (dropped size/quality, adjusted aspect ratio…)
            // are not failures: record them quietly in the INFO pool instead of
            // toasting on every generation.
            if (Array.isArray(entry?.warnings) && entry.warnings.length) {
                reportFailure({
                    scope: URIS_SCOPES.provider,
                    message: entry.warnings.map(w => `${w?.feature || '?'}: ${w?.details || ''}`).join('; '),
                    context: entry?.generationContext || null,
                    quiet: true,
                    level: 'warn',
                });
            }
            if (getActiveTab() === 'gallery') refreshActive();
        }).catch(e => {
            if (e?.name === 'AbortError') {
                // Items not yet started when the queue stops reject as
                // 'Queue stopped' (silent here; see processQueue's finally);
                // the in-flight item rejects as 'Aborted by user' and toasts once.
                if (e?.message !== 'Queue stopped') toastr?.info('Генерация отменена');
            } else {
                error('Generate action:', e?.message || e);
                reportFailure({ scope: URIS_SCOPES.generation, message: e?.message || String(e), context: e?.urisContext || null, toast: true });
            }
        });
    } catch (e) {
        error('Generate action:', e?.message || e);
        reportFailure({ scope: URIS_SCOPES.generation, message: e?.message || String(e), context: e?.urisContext || null, toast: true });
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

function updatePostInfo(root) {
    const info = root.querySelector('#urisPostInfo');
    if (!info) return;
    info.textContent = getPostInfo();
    // Панель референсов обновляет render() — один await-вызов с реальной
    // resolution. Дублирующий fire-and-forget вызов здесь запускал второй
    // параллельный refreshReferencePanel: поздний null-args прогон затирал
    // Stage2-чипы/превью до «нет совпадений» и ×2–×4 нагружал policy-резолвы.
}

// Barrel re-exports: the moved panel/lifecycle surfaces stay importable from
// this module for the tab's consumers and tests.
export {
    updateReferenceCorrections,
    buildReferencePanelState,
    resolveConnectionReferencePolicy,
    renderReferencePreviewMarkup,
    renderPromptAmbiguities,
    renderAmbiguitiesMarkup,
    renderMatchedKeywords,
    renderLivePreview,
    refreshReferencePanel,
    getSnapshotReferencePolicy,
} from './tab-generate-refs.js';
export { setCancelState, syncCancelState, bindAbortUI, unbindAbortUI } from './generation-lifecycle-ui.js';
