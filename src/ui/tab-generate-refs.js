// @ts-check
/**
 * References panel of the Generate tab: corrections, policy resolution,
 * whitelist chips with pointer drag, and the live "what will be sent" preview.
 * Extracted from tab-generate.js (v0.9.5 split); the tab module re-exports the
 * public surface as a barrel.
 */
import { state, escapeHtml, warn } from '../core.js';
import { buildCandidates } from '../pipeline.js';
import { resolvePromptReferenceContext } from '../scene-context.js';
import { getGenerationDraft, updateGenerationDraft } from '../generation-drafts.js';
import { resolveChatConfigSnapshot } from '../pipeline-config.js';
import { getConnection, isServerOwnedConnection, saveConnection } from '../connections.js';
import { effectiveReferenceCap } from '../reference-limits.js';
import { resolveDispatchPlan, referenceEncoding } from '../dispatch-plan.js';
import { recordUrisError } from '../error-pool.js';
import { getChatRefs, saveChatRefs, listFolders, listRefs } from '../refs-library.js';
import { showPoolPicker } from './tab-references.js';
import { openFolderSheet } from './folder-picker.js';
import { bindDetailsToggle } from './accordion-state.js';
import { refreshActive } from './tabs.js';
import { activeScope } from './tab-generate-scope.js';
// Cycle by design: the correction helpers re-render the tab. Render is only
// CALLED from event handlers, so the ESM live binding is initialized by then.
import { render } from './tab-generate.js';

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
export function renderAmbiguitiesMarkup(ambiguities, entities) {
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
 * Resolve the current prompt-driven Stage 2 reference set for a draft.
 *
 * @param {string} chatId
 * @param {import('../generation-drafts.js').GenerationDraft} draft
 * @returns {Promise<import('../scene-context.js').SceneContextSnapshot>}
 */
export async function resolveDraftPromptReferences(chatId, draft) {
    const candidates = await buildCandidates(chatId);
    return await resolvePromptReferenceContext({
        prompt: draft.prompt,
        candidates,
        corrections: draft.references || { includedIds: [], excludedIds: [], revision: 0 },
    });
}

/**
 * Apply a manual inclusion/exclusion correction for an ambiguous mention,
 * rebuild the shared snapshot, and re-render the tab.
 * @param {HTMLElement} root
 * @param {string} candidateId
 * @param {boolean} include
 */
export async function applyReferenceCorrection(root, candidateId, include) {
    const scope = activeScope(root);
    if (!scope.studio && scope.msgId == null) return;

    await updateGenerationDraft(scope.chatId, scope.msgId, scope.messageText, d => ({
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
 * All corrections are applied in ONE draft update and followed by ONE render —
 * the per-ref loop used to run applyReferenceCorrection N times, and each of
 * those ended in a full tab re-render (N picks = N complete re-renders).
 * @param {HTMLElement} root
 * @param {string[]} refIds
 */
export async function addStage2Includes(root, refIds) {
    if (!Array.isArray(refIds) || refIds.length === 0) return;
    const chatRefs = getChatRefs();
    const nextIds = [...chatRefs.referenceIds];
    for (const refId of refIds) {
        if (!nextIds.includes(refId)) nextIds.push(refId);
    }
    saveChatRefs({ referenceIds: nextIds });
    const scope = activeScope(root);
    if (!scope.studio && scope.msgId == null) return;
    await updateGenerationDraft(scope.chatId, scope.msgId, scope.messageText, d => {
        let references = d.references;
        for (const refId of refIds) {
            references = updateReferenceCorrections(references, refId, true);
        }
        return { ...d, references };
    });
    await render(root);
}

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

    // Pool-backed source sections: persistent open/close (src/ui/accordion-state.js).
    // Previously open was derived from data presence — now it is fully manual: the user
    // decides whether to collapse or expand, and the choice persists across reloads.
    bindDetailsToggle(
        root.querySelector('details.uris-advanced'),
        'generate:advanced',
    );

    await renderWhitelistChips(root, chatRefs);
}

export function renderMatchedKeywords(root, stage1Snapshot, stage2Resolution) {
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
        openFolderSheet({
            title,
            folders: available,
            mode: 'multi',
            onDone: ids => resolve(Array.isArray(ids) ? ids : []),
            onCancel: () => resolve([]),
        });
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
    // Отдельные карточки рисуются внутри строки actions (после папок): отдельная
    // группа с заголовком стоила лишней строки интерфейса даже когда пустела.
    const directMarkup = directRefs.map(ref => ref.missing ? renderStaleRef(ref.id) : renderChip(ref, true)).join('');

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
    host.innerHTML = `${folderGroups.join('')}<div class="uris-refs-whitelist-actions">${directMarkup}
        <button class="uris-refs-add-tile uris-add-extra" title="Добавить референс в whitelist" aria-label="Добавить референс в whitelist"><i class="fa-solid fa-plus"></i></button>
        <button class="uris-refs-add-tile uris-add-folder" title="Добавить папку в whitelist" aria-label="Добавить папку в whitelist"><i class="fa-solid fa-folder-plus"></i></button>
    </div>`;

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

export async function resolveCurrentRootReferences(root) {
    const scope = activeScope(root);
    if (!scope.studio && scope.msgId == null) return null;
    const draft = await getGenerationDraft(scope.chatId, scope.msgId, scope.messageText);
    return await resolveDraftPromptReferences(scope.chatId, draft);
}

export async function getSnapshotReferencePolicy(snapshot, loadConnection = getConnection) {
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


export async function getActiveReferencePolicy() {
    const snapshot = await resolveChatConfigSnapshot();
    return getSnapshotReferencePolicy(snapshot);
}

/**
 * getActiveReferencePolicy that degrades instead of rejecting. A throw here
 * (resolveChatConfigSnapshot → assertImageModelEligible) would break every caller,
 * including the fire-and-forget updatePostInfo path (unhandled rejection + a
 * half-cleared reference panel). The panel renders the degraded message instead.
 */
async function safeReferencePolicy() {
    try {
        return await getActiveReferencePolicy();
    } catch (e) {
        warn('Generate tab: reference policy failed:', e?.message || e);
        return {
            supported: false,
            maxRefs: null,
            canAdd: false,
            unsupported: true,
            overLimit: false,
            message: 'Не удалось определить политику референсов соединения.',
        };
    }
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
    const policy = await safeReferencePolicy();
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
