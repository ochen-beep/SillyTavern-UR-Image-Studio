// @ts-check
/**
 * Pure view layer of the Generate tab: view-model builders and markup
 * renderers. No DOM access, no async state — bindings, render() and the
 * submission flow live in tab-generate.js, which re-exports everything from
 * here so consumers keep importing from the tab module.
 */
import { state, escapeHtml, VALID_ASPECT_RATIOS, VALID_IMAGE_SIZES } from '../core.js';
import { POST_FILTER, getFilter } from '../post-navigator.js';
import { hashMessage, normalizeTemplateSelection, resolveDraftTemplateId } from '../generation-drafts.js';
import { STUDIO_CHAT_ID } from '../studio-scope.js';
import { detectModelFamily, VALID_PARAMS } from '../dispatch-plan.js';
import { renderAmbiguitiesMarkup } from './tab-generate-refs.js';

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
    // Stale badge lives in the references panel head now (the excerpt is gone —
    // the post is readable in the chat itself).
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

    // Source block: in a chat the post text is already readable in the chat
    // itself, so no excerpt — the ambiguity resolver lives in the references
    // panel now. In the studio the scene text is an input the user edits freely.
    const sourceBlock = isStudio
        ? `
            <div class="uris-context-box uris-studio-scene">
                <textarea class="text_pole uris-scene-area" id="urisScene" rows="3" placeholder="Текст сцены — по нему распознаются референсы. Можно оставить пустым и написать промпт напрямую.">${escapeHtml(vm.messageText || '')}</textarea>
                <div class="uris-scene-context">${ambiguityList}</div>
            </div>`
        : '';

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
    // Row order per UI revision #14: «Флоу» first, «Автоматизация» second.
    const chatOnlyParams = isStudio ? '' : `
                <span class="uris-param"><span class="uris-param-label">Флоу</span>
                    <select class="text_pole" id="urisGenerationFlow">
                        <option value="${POST_FILTER.AI_ONLY}" ${getFilter() === POST_FILTER.AI_ONLY ? 'selected' : ''}>Только AI</option>
                        <option value="${POST_FILTER.USER_ONLY}" ${getFilter() === POST_FILTER.USER_ONLY ? 'selected' : ''}>Только пользователь</option>
                        <option value="${POST_FILTER.ALL}" ${getFilter() === POST_FILTER.ALL ? 'selected' : ''}>Все сообщения</option>
                        <option value="${POST_FILTER.MANUAL}" ${getFilter() === POST_FILTER.MANUAL ? 'selected' : ''}>Ручной выбор</option>
                    </select></span>
                <span class="uris-param"><span class="uris-param-label">Автоматизация</span>
                    <select class="text_pole" id="urisAutomationMode">
                        <option value="manual" ${vm.automationMode === 'manual' ? 'selected' : ''}>Вручную</option>
                        <option value="build-prompt" ${vm.automationMode === 'build-prompt' ? 'selected' : ''}>Строить промпт</option>
                        <option value="full-pipeline" ${vm.automationMode === 'full-pipeline' ? 'selected' : ''}>Полный pipeline</option>
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
                <span class="uris-param"><span class="uris-param-label">Модель</span>${renderModelSelectMarkup(vm.modelChoices)}</span>
            </div>
            <div class="uris-gen-params">
                <span class="uris-param"><span class="uris-param-label">Шаблон</span>
                    <select class="text_pole" id="urisTemplate">${templateOptions}</select></span>
            </div>
            <details class="uris-gen-acc" data-accordion-id="generate:params" id="urisGenParamsAcc">
                <summary>Дополнительно</summary>
                <div class="uris-gen-params">
                    <span class="uris-param"><span class="uris-param-label">Размер</span>
                        <select class="text_pole" id="urisImgSize">${VALID_IMAGE_SIZES.map(s => `<option ${s === draft.imageSize ? 'selected' : ''}>${s}</option>`).join('')}</select></span>
                    <span class="uris-param"><span class="uris-param-label">Quality</span>
                        <select class="text_pole" id="urisQuality">${vm.qualityOptions || qualityOptionsFor('', draft.quality)}</select></span>
                </div>
                <div class="uris-gen-params">
                    ${chatOnlyParams}
                </div>
                <div class="uris-s1-ctx">
                    <div class="uris-s1-ctx-title">Контекст Stage 1</div>
                    <label class="checkbox_label"><input type="checkbox" id="uris_s1_persona" ${state.settings.stage1IncludePersona === true ? 'checked' : ''}><span>Карточка {{user}} (персона)</span></label>
                    <label class="checkbox_label"><input type="checkbox" id="uris_s1_character" ${state.settings.stage1IncludeCharacter === true ? 'checked' : ''}><span>Карточка {{char}} (описание и личность)</span></label>
                    <label class="checkbox_label"><input type="checkbox" id="uris_s1_lore" ${state.settings.stage1IncludeLore === true ? 'checked' : ''}><span>Лорбук чата и персонажа</span></label>
                    <div class="uris-field">
                        <label for="uris_s1_history">История чата — сообщений до выбранного поста (0 — выключено)</label>
                        <input type="number" class="text_pole uris-w-num" id="uris_s1_history" min="0" max="100" step="1" inputmode="numeric"
                            value="${Number.isFinite(state.settings.stage1HistoryDepth) ? state.settings.stage1HistoryDepth : 0}">
                    </div>
                    <small class="uris-hint">Дополнительный контекст текстового Шага 1: выбранные блоки уходят в LLM вместе со сценой.</small>
                </div>
            </details>

            <div class="uris-refs-panel" id="urisRefsPanel">
                <div class="uris-refs-panel-head">
                    <span class="uris-refs-status-label">Референсы</span>
                    ${staleBadge}
                </div>
                ${isStudio ? '' : `<div class="uris-scene-context uris-refs-ambiguities">${ambiguityList}</div>`}
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
export function renderEmptyStateMarkup() {
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
