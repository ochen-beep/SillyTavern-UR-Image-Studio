// @ts-check
/** Templates tab: instruction templates only. */
import { state, escapeHtml, showConfirmModal, showInputModal, debounceSave } from '../core.js';
import { listTemplates, saveTemplate, deleteTemplate, createInstructionTemplate } from '../prompt-templates.js';
import { patchChatConfig } from '../chat-binding.js';
import { refreshActive } from './tabs.js';
import { generatePromptText } from '../text-api.js';
import { editTextModal } from './text-editor.js';

/** @param {HTMLElement} root */
export function render(root) {
    root.innerHTML = `
        <div class="uris-templates">
            <div class="uris-templates-list" id="urisTemplatesList"></div>
            <div class="uris-templates-actions" id="urisTemplatesActions"></div>
        </div>`;
    return Promise.all([renderActions(root), renderList(root)]);
}

async function renderActions(root) {
    const host = root.querySelector('#urisTemplatesActions');
    if (!host) return;
    host.innerHTML = renderTemplateCreateActions(state.settings.experimentalTemplateFromDescription === true);
    host.querySelectorAll('[data-create-type]').forEach(button => {
        button.addEventListener('click', async () => {
            if (button.dataset.createType === 'instruction') {
                await createInstructionTemplate({ name: 'Новый instruction' });
                refreshActive();
            } else if (button.dataset.createType === 'description') {
                await createTemplateFromDescription();
            }
        });
    });
}

/** @param {boolean} experimentalEnabled */
export function renderTemplateCreateActions(experimentalEnabled) {
    const descriptionButton = experimentalEnabled
        ? `<button class="uris-btn uris-btn-outline" data-create-type="description"><i class="fa-solid fa-wand-magic-sparkles"></i> Из описания</button>`
        : '';
    return `<div class="uris-templates-create">
        <button class="uris-btn uris-btn-outline" data-create-type="instruction"><i class="fa-solid fa-plus"></i> Instruction</button>
        ${descriptionButton}
    </div>`;
}

let _listRenderEpoch = 0;

async function renderList(root) {
    const epoch = ++_listRenderEpoch;
    const host = root.querySelector('#urisTemplatesList');
    const templates = await listTemplates();
    if (_listRenderEpoch !== epoch || root.__urisTabId !== 'templates' || !host?.isConnected) return;
    host.innerHTML = templates.map(renderTemplateCard).join('');
    bindCards(host);
}

/** @param {{id:string,name:string,instruction:string,collapsed?:boolean}} template */
export function renderTemplateCard(template) {
    const active = template.id === state.activeTemplateId;
    const safeId = escapeHtml(template.id);
    const collapsed = template.collapsed === true;
    return `<div class="uris-preset-card uris-template-instruction ${active ? 'uris-template-active' : ''}${collapsed ? ' uris-collapsed' : ''}" data-id="${safeId}" data-type="instruction">
        <div class="uris-preset-card-header">
            <button class="uris-template-status${active ? ' uris-status-active' : ''}" type="button" title="${active ? 'Активен' : 'Сделать активным'}" aria-label="${active ? 'Активен' : 'Сделать активным'}"></button>
            <input class="text_pole uris-name" value="${escapeHtml(template.name)}" placeholder="Название шаблона">
            <button class="uris-name-edit" type="button" title="Переименовать" aria-label="Переименовать"><i class="fa-solid fa-pencil"></i></button>
        </div>
        <div class="uris-preset-card-body"${collapsed ? ' hidden' : ''}>
            <div class="uris-field"><div class="uris-field-head"><label>Инструкция для Stage1</label>
                <button class="uris-expand-btn" type="button" data-act="expand-instruction" title="Развернуть редактор" aria-label="Развернуть редактор"><i class="fa-solid fa-maximize"></i></button></div>
                <textarea class="text_pole uris-instruction" rows="8" placeholder="Системная инструкция, которая отправляется к текстовой модели...">${escapeHtml(template.instruction || '')}</textarea>
                <small class="uris-hint">Макросы ST: {{char}}, {{user}}.</small></div>
            <div class="uris-row">
                <button class="uris-btn uris-btn-confirm uris-activate" data-id="${safeId}" ${active ? 'disabled title="Уже активен"' : 'title="Сделать активным"'}><i class="fa-solid fa-check"></i> ${active ? 'Активен' : 'Сделать активным'}</button>
                <button class="uris-btn uris-btn-ghost uris-del" data-id="${safeId}"><i class="fa-solid fa-trash"></i> Удалить</button>
            </div>
        </div>
    </div>`;
}

/** @param {HTMLElement} host */
function bindCards(host) {
    for (const card of host.querySelectorAll('.uris-preset-card')) {
        const id = card.dataset.id;
        const collect = () => ({
            id,
            name: card.querySelector('.uris-name')?.value || 'Шаблон',
            type: 'instruction',
            instruction: card.querySelector('.uris-instruction')?.value || '',
        });
        const save = async () => { await saveTemplate(collect()); };
        // Expanded editor (ST-style maximized_textarea popup). Direct save()
        // instead of dispatching 'change': the card-level save listens for
        // bubbled change events, which the fake-dom tests don't propagate.
        card.querySelector('[data-act="expand-instruction"]')?.addEventListener('click', async () => {
            const ta = card.querySelector('.uris-instruction');
            if (!ta) return;
            const next = await editTextModal({ value: ta.value, title: 'Инструкция для Stage1', placeholder: 'Системная инструкция, которая отправляется к текстовой модели...' });
            if (next === null || next === ta.value) return;
            ta.value = next;
            await save();
        });
        card.addEventListener('change', save);
        card.addEventListener('input', debounceSave(saveTemplate, id, collect));
        card.querySelector('.uris-preset-card-header')?.addEventListener('click', event => {
            if (event.target.closest('input, button, select, textarea')) return;
            const body = card.querySelector('.uris-preset-card-body');
            const willClose = !body?.hidden;
            if (body) body.hidden = willClose;
            card.classList.toggle('uris-collapsed', willClose);
            saveTemplate({ ...collect(), collapsed: willClose });
        });
        // The name is a label by default (pointer-events:none); the pencil
        // switches it into edit mode, and Enter commits (blur -> change -> save).
        card.querySelector('.uris-name-edit')?.addEventListener('click', () => card.querySelector('.uris-name')?.focus());
        card.querySelector('.uris-name')?.addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
        const activate = async () => {
            state.activeTemplateId = id || null;
            await patchChatConfig({ templateId: id || null });
            toastr?.success('Шаблон применён');
            refreshActive();
        };
        // The header dot activates from the collapsed state too; stopPropagation
        // keeps the header collapse handler (above) from firing on a real
        // browser's bubbling phase (in fake-dom clicks don't bubble to parent).
        card.querySelector('.uris-template-status')?.addEventListener('click', async event => {
            event.stopPropagation();
            event.preventDefault();
            if (id) await activate();
        });
        card.querySelector('.uris-activate')?.addEventListener('click', activate);
        card.querySelector('.uris-del')?.addEventListener('click', async () => {
            if (!await showConfirmModal('Удалить шаблон?')) return;
            await deleteTemplate(id);
            if (state.activeTemplateId === id) {
                state.activeTemplateId = null;
                await patchChatConfig({ templateId: null });
            }
            refreshActive();
        });
    }
}

async function createTemplateFromDescription() {
    if (state.settings.experimentalTemplateFromDescription !== true) {
        throw new Error('Experimental template creation is disabled');
    }
    const description = await showInputModal('Описание шаблона:', '');
    if (!description) return;
    const system = 'You are a template generator for an image prompt pipeline. Return ONLY a JSON object with { "name": "...", "instruction": "..." }.';
    let parsed;
    try {
        parsed = JSON.parse(await generatePromptText(system, description, () => {}));
    } catch {
        throw new Error('Template description returned invalid JSON');
    }
    if (!parsed || typeof parsed.name !== 'string' || typeof parsed.instruction !== 'string') {
        throw new Error('Template description returned invalid JSON');
    }
    await createInstructionTemplate({ name: parsed.name || 'Из описания', instruction: parsed.instruction });
    refreshActive();
}
