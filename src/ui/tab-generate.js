// @ts-check
/**
 * Generation tab v3: prompt-first editor over message-scoped draft.
 * Layout: post-navigator, excerpt/stale badge, prompt editor, actions Stage 1 / Stage 2,
 * compact aspect/size/quality controls, references panel, Advanced (template/automation/queue).
 */
import { state, getCtx, error, warn, abortGeneration, saveSettings } from '../core.js';
import { bindDetailsToggle } from './accordion-state.js';
import { guardDuplicateSubmission } from './submit-guard.js';
import { navigatePosts, getPostInfo, setFilter, setCurrentMsgId, getLastPostIndex } from '../post-navigator.js';
import { runStage1ForDraft, enqueueGeneration, createQueueItem, buildCandidates } from '../pipeline.js';
import { getGenerationDraft, updateGenerationDraft, resolveDraftTemplateId, noteLiveGenerationParams, getLiveGenerationParams } from '../generation-drafts.js';
import { listTemplates, getTemplate } from '../prompt-templates.js';
import { resolveSTMacros } from '../template-runtime.js';
import { patchChatConfig, loadChatConfig } from '../chat-binding.js';
import { getActiveTab, refreshActive } from './tabs.js';
import { getRefSync } from '../refs-library.js';
import { showSingleImage } from './lightbox.js';
import { editTextModal } from './text-editor.js';
import { resolveChatConfigSnapshot, resolveStage1ChatConfigSnapshot } from '../pipeline-config.js';
import { getConnection } from '../connections.js';
import {
    getVisibleModelChoices,
    classifyModelCapability,
} from '../dispatch-plan.js';
import { reportFailure, URIS_SCOPES } from '../error-pool.js';
import { isStudioActive, STUDIO_CHAT_ID, STUDIO_MSG_ID } from '../studio-scope.js';

import { activeScope, setGenerateRoot, getGenerateRoot } from './tab-generate-scope.js';
import {
    buildGenerateViewModel,
    renderGenerateMarkup,
    renderEmptyStateMarkup,
    qualityOptionsFor,
    composeEffectiveParams,
    composeInsertedPrompt,
} from './tab-generate-markup.js';
import {
    updateReferenceCorrections,
    buildReferencePanelState,
    resolveConnectionReferencePolicy,
    renderReferencePreviewMarkup,
    renderPromptAmbiguities,
    renderMatchedKeywords,
    renderLivePreview,
    refreshReferencePanel,
    resolveDraftPromptReferences,
    applyReferenceCorrection,
    addStage2Includes,
    getSnapshotReferencePolicy,
} from './tab-generate-refs.js';
import { setCancelState, syncCancelState, bindAbortUI, unbindAbortUI } from './generation-lifecycle-ui.js';

// Barrel: the pure view layer moved to tab-generate-markup.js; keep every
// former export importable from this module for consumers and tests.
export {
    decidePromptActions,
    buildGenerateViewModel,
    renderGenerateMarkup,
    renderEmptyStateMarkup,
    qualityOptionsFor,
    renderModelSelectMarkup,
    composeEffectiveParams,
    composeInsertedPrompt,
} from './tab-generate-markup.js';

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
 * Write one generation default with the "use for all chats" semantics: when
 * the global mode is on AND the chat has no own value for the key, the change
 * lands in settings.globalGenerationDefaults (visible to every chat); an
 * existing chat value is overridden as usual (patchChatConfig). Reading side
 * (chat ?? global) already lives in chat-binding.js / pipeline-config.js.
 * Exported for tests.
 */
export async function saveGenerationDefaultByKey(key, value) {
    let toGlobal = false;
    if (state.settings?.useParametersForAllChats === true) {
        try {
            const binding = await loadChatConfig();
            toGlobal = binding?.config?.generationDefaults?.[key] == null;
        } catch { toGlobal = false; }
    }
    if (toGlobal) {
        state.settings.globalGenerationDefaults = {
            ...(state.settings.globalGenerationDefaults || {}),
            [key]: value || null,
        };
        saveSettings();
    } else {
        await patchChatConfig({ generationDefaults: { [key]: value || null } });
    }
    state.generationDefaults = { ...(state.generationDefaults || {}), [key]: value || null };
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
            await saveGenerationDefaultByKey('modelId', modelId);
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
    // The "Advanced" row (Size/Quality/Flow/Automation) lives under a
    // collapsible; its position persists in settings.accordionState and
    // survives page reloads (accordion-state.js).
    bindDetailsToggle(root.querySelector('#urisGenParamsAcc'), 'generate:params');
    syncCancelState(root);
    bindModelSelect(root, modelChoices, { onSwitched: () => render(root) });
    if (!studio) updatePostInfo(root);
    refreshReferencePanel(root, referenceResolution, snapshot);
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

/**
 * Bind all Generate tab event listeners to the rendered root.
 * @param {HTMLElement} root
 */
export function bindGenerate(root) {
    // Stage 1 context toggles (moved here from Settings — a generation concern):
    // same ids, same persistence as before.
    for (const [id, key] of [
        ['#uris_s1_persona', 'stage1IncludePersona'],
        ['#uris_s1_character', 'stage1IncludeCharacter'],
        ['#uris_s1_lore', 'stage1IncludeLore'],
    ]) {
        root.querySelector(id)?.addEventListener('change', e => {
            state.settings[key] = e.target.checked === true;
            saveSettings();
        });
    }
    root.querySelector('#uris_s1_history')?.addEventListener('change', e => {
        // Any depth 0–100 (was a fixed 0/5/10/20 select); clamped and mirrored
        // back into the field so it always shows the effective value.
        const depth = Math.max(0, Math.min(100, Math.floor(Number(e.target.value) || 0)));
        state.settings.stage1HistoryDepth = depth;
        e.target.value = String(depth);
        saveSettings();
    });

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
        // let-outside-try: the catch reads it to report the failed post; a
        // try-scoped const made every failure a silent ReferenceError instead.
        let input = null;
        try {
            // Stage 1 runs on the light config: image-model eligibility is
        // irrelevant to building a prompt and must not block it.
        input = await prepareSubmissionInput(root, { light: true });
            if (!input) return;
            const run = await runStage1ForDraft(input);
            if (run.applied) {
                toastr?.success('Промпт построен');
            } else if (run.reason === 'prompt-edited') {
                // The live manual edit outranks the finished build — say so
                // instead of leaving a long run looking like a silent failure.
                toastr?.info('Промпт отброшен: отредактирован вручную');
            } else if (run.reason === 'superseded') {
                toastr?.info('Промпт отброшен: заменён более новым прогоном');
            }
        } catch (e) {
            error('Generate action:', e?.message || e);
            reportFailure({ scope: URIS_SCOPES.stage1, message: e?.message || String(e), context: input ? { post: input.msgId } : null, toast: true });
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
    // manual choice survives re-render, navigation, and chat reloads. With the
    // global mode on, a first-time choice writes the global default instead.
    const saveGenerationDefault = async (key, value) => {
        await saveGenerationDefaultByKey(key, value);
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
 * @param {{light?:boolean}} [opts] light — Stage 1 chat-config snapshot without
 *   the image-model validation: prompt building does not touch the image model.
 * @returns {Promise<object|null>} null when there is no post to submit for
 */
export async function prepareSubmissionInput(root, { light = false } = {}) {
    const chatConfig = light ? await resolveStage1ChatConfigSnapshot() : await resolveChatConfigSnapshot();
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
        // Duplicate-run guard: the same generation queued or running twice
        // means a second paid attempt. Explicit bypass stays with the user.
        if (!await guardDuplicateSubmission(item, { chatId: input.chatId, msgId: input.msgId }, deps)) return;
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
    refreshReferencePanel,
    getSnapshotReferencePolicy,
} from './tab-generate-refs.js';
export { setCancelState, syncCancelState, bindAbortUI, unbindAbortUI } from './generation-lifecycle-ui.js';
