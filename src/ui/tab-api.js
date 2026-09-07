// @ts-check
/**
 * API tab: Text-LLM source configuration and server-owned image connections.
 */
import { state, escapeHtml, saveSettings, getApiKey, setApiKey } from '../core.js';
import { listImageConnections } from '../connections.js';
import { patchChatConfig } from '../chat-binding.js';
import { getProfiles, getProfileDetails } from '../text-connection.js';
import { bindHeaderToggle } from './accordion-state.js';
import { recordUrisError } from '../error-pool.js';
import {
    bindServerConnectionForm, renderServerConnectionForm,
} from './server-connection-form.js';

export function render(root) {
    root.innerHTML = `
        <div class="uris-api">
            <div class="uris-accordion" id="urisTextLLMSection"></div>
            <div class="uris-accordion" id="urisImageConnSection"></div>
        </div>`;
    const text = renderTextLLMSection(root.querySelector('#urisTextLLMSection'));
    const image = renderImageConnSection(root.querySelector('#urisImageConnSection'));
    for (const header of root.querySelectorAll('.uris-acc-header')) {
        const body = header.nextElementSibling;
        if (body?.classList.contains('uris-acc-body')) {
            bindHeaderToggle(header, body, header.dataset.accordionId || '');
        }
    }
    return Promise.all([text, image]);
}

// ── Text-LLM source ──

async function renderTextLLMSection(host) {
    const src = state.settings.apiSource || 'profile';
    host.innerHTML = accordion('Text-LLM источник', `
        <div class="uris_field_group">
            <div class="uris_seg" id="uris_source">
                <button class="uris_seg_btn ${src === 'profile' ? 'uris_seg_active' : ''}" data-uris-src="profile" type="button" aria-pressed="${src === 'profile'}">Профиль</button>
                <button class="uris_seg_btn ${src === 'custom' ? 'uris_seg_active' : ''}" data-uris-src="custom" type="button" aria-pressed="${src === 'custom'}">Свой</button>
            </div>
        </div>
        <div class="uris_field_group" id="uris_profile_group" hidden>
            <span class="uris_field_label"><i class="fa-solid fa-user-gear fa-fw"></i> Профиль подключения</span>
            <select id="uris_profile" class="text_pole"><option value="">— Выберите профиль —</option></select>
            <div id="uris_profile_info" hidden class="uris-muted">
                <i class="fa-solid fa-microchip fa-fw"></i> <span id="uris_profile_model"></span>
            </div>
        </div>
        <div id="uris_custom_group" hidden>
            <div class="uris_field_group">
                <span class="uris_field_label"><i class="fa-solid fa-link fa-fw"></i> URL эндпоинта</span>
                <input type="url" id="uris_endpoint" class="text_pole" placeholder="https://api.example.com/v1" value="${escapeHtml(state.settings.customEndpoint || '')}">
                <small class="uris_hint">Прямой запрос из браузера — эндпоинт должен отдавать CORS-заголовки.</small>
            </div>
            <div class="uris_field_group">
                <span class="uris_field_label"><i class="fa-solid fa-key fa-fw"></i> API-ключ</span>
                <input type="password" id="uris_apikey" class="text_pole" placeholder="sk-...">
            </div>
            <div class="uris_field_group">
                <span class="uris_field_label"><i class="fa-solid fa-microchip fa-fw"></i> ID модели (необязательно)</span>
                <input type="text" id="uris_model" class="text_pole" placeholder="По умолчанию у API" value="${escapeHtml(state.settings.customModel || '')}">
            </div>
        </div>`, 'api:text-llm');
    bindTextLLMSection(host);
    populateApiKey(host);
    updateSourceFieldsVisibility(host);
}

function bindTextLLMSection(host) {
    host.querySelector('#uris_source').addEventListener('click', e => {
        const btn = e.target.closest('[data-uris-src]');
        if (!btn) return;
        state.settings.apiSource = btn.dataset.urisSrc;
        saveSettings();
        host.querySelectorAll('[data-uris-src]').forEach(b => {
            const active = b === btn;
            b.classList.toggle('uris_seg_active', active);
            b.setAttribute('aria-pressed', String(active));
        });
        updateSourceFieldsVisibility(host);
    });

    host.querySelector('#uris_profile').addEventListener('change', e => {
        state.settings.profileId = e.target.value;
        saveSettings();
        updateProfileModelInfo(host);
    });

    host.querySelector('#uris_endpoint').addEventListener('input', debouncedSaveField('customEndpoint'));
    host.querySelector('#uris_endpoint').addEventListener('change', debouncedSaveField('customEndpoint'));
    host.querySelector('#uris_model').addEventListener('input', debouncedSaveField('customModel'));
    host.querySelector('#uris_model').addEventListener('change', debouncedSaveField('customModel'));

    let apiKeySaveTimer;
    host.querySelector('#uris_apikey').addEventListener('input', e => {
        const value = e.target.value;
        clearTimeout(apiKeySaveTimer);
        apiKeySaveTimer = setTimeout(async () => {
            await setApiKey(value);
        }, 600);
    });
}

async function populateApiKey(host) {
    const el = host.querySelector('#uris_apikey');
    if (!el) return;
    try { el.value = (await getApiKey()) || ''; } catch { /* non-critical */ }
}

function updateSourceFieldsVisibility(host) {
    const profileGroup = host.querySelector('#uris_profile_group');
    const customGroup = host.querySelector('#uris_custom_group');
    const isProfile = state.settings.apiSource === 'profile';
    const isCustom = state.settings.apiSource === 'custom';
    if (profileGroup) profileGroup.hidden = !isProfile;
    if (customGroup) customGroup.hidden = !isCustom;
    if (isProfile) {
        populateProfiles(host).catch(() => {});
        updateProfileModelInfo(host);
    }
}

async function populateProfiles(host) {
    const select = host.querySelector('#uris_profile');
    if (!select) return;
    try {
        const profiles = await getProfiles();
        select.innerHTML = '<option value="">— Выберите профиль —</option>';
        profiles.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id || p.name;
            opt.textContent = p.name;
            if ((p.id || p.name) === state.settings.profileId) opt.selected = true;
            select.appendChild(opt);
        });
    } catch {
        select.innerHTML = '<option value="">Ошибка загрузки профилей</option>';
    }
}

let modelInfoRequest = 0;
async function updateProfileModelInfo(host) {
    const info = host.querySelector('#uris_profile_info');
    const text = host.querySelector('#uris_profile_model');
    if (!info || !text) return;
    const request = ++modelInfoRequest;
    text.textContent = '';
    if (state.settings.apiSource !== 'profile' || !state.settings.profileId) {
        info.hidden = true;
        return;
    }
    try {
        const details = await getProfileDetails(state.settings.profileId);
        if (request !== modelInfoRequest) return;
        if (details) {
            const model = details.model || details.modelName || details.model_name || details.settings?.model || '';
            text.textContent = model || 'Модель не указана';
            info.hidden = false;
        }
    } catch { /* non-critical: info stays hidden */ }
}

function debouncedSaveField(prop) {
    let timer;
    return e => {
        clearTimeout(timer);
        const value = e.target.value;
        timer = setTimeout(() => {
            state.settings[prop] = value;
            saveSettings();
        }, 400);
    };
}

// ── Browser image connections ──

/**
 * Re-render a single server-connection card in place without throwing away
 * the host tab's scroll position or the focus inside the card's inputs.
 * Used by the auto-save path (server-connection-form `onSaved`) so editing a
 * field no longer re-mounts the whole API tab.
 *
 * @param {HTMLElement} form existing card root element (.uris-server-connection)
 * @param {object} draft in-memory connection draft (already synced to the form)
 * @param {() => Promise<void>} rerenderHost full host re-render, for probe/delete
 */
function rerenderCard(form, draft, rerenderHost, setActive) {
    const body = document.getElementById('urisBody');
    const scrollY = body?.scrollTop ?? 0;
    const scrollX = body?.scrollLeft ?? 0;

    // Capture focus + selection so we can restore them after the DOM swap.
    const active = document.activeElement;
    let focusInfo = null;
    if (active && form.contains(active)) {
        const inputs = Array.from(form.querySelectorAll('input, select, textarea'));
        const idx = inputs.indexOf(active);
        if (idx !== -1) {
            focusInfo = {
                idx,
                selectionStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
                selectionEnd: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
            };
        }
    }

    // renderServerConnectionForm re-reads the accordion open/closed state via
    // getAccordionOpen(accordionId(id)) — which the header-toggle keeps in sync,
    // so the re-rendered markup preserves the visible collapse state.
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderServerConnectionForm(draft, { isActive: draft.id === state.activeImageProfileId });
    const newForm = wrapper.firstElementChild;
    if (!(newForm instanceof HTMLElement)) return;
    form.replaceWith(newForm);

    bindServerConnectionForm(newForm, draft, {
        rerender: rerenderHost,
        onSaved: () => rerenderCard(newForm, draft, rerenderHost, setActive),
        rerenderCard: () => rerenderCard(newForm, draft, rerenderHost, setActive),
        notifyError: error => {
            recordUrisError({ scope: 'API', message: error?.message || String(error) });
            toastr?.error(error?.message || String(error));
        },
        setActive,
    });

    if (body) { body.scrollTop = scrollY; body.scrollLeft = scrollX; }
    if (focusInfo) {
        const inputs = Array.from(newForm.querySelectorAll('input, select, textarea'));
        const el = inputs[focusInfo.idx];
        if (el) {
            el.focus();
            if (typeof el.setSelectionRange === 'function' && focusInfo.selectionStart != null) {
                try { el.setSelectionRange(focusInfo.selectionStart, focusInfo.selectionEnd ?? focusInfo.selectionStart); } catch {}
            }
        }
    }
}

export async function renderImageConnSection(host) {
    const connections = await listImageConnections();
    const imageConnections = await Promise.all(connections.map(async connection => {
        try {
            const { getConnectionApiKey } = await import('../connection-store.js');
            return { ...connection, apiKey: (await getConnectionApiKey(connection.id)) || '' };
        } catch (error) {
            return { ...connection, apiKey: '', errorMessage: error?.message || 'API key status unavailable' };
        }
    }));

    host.innerHTML = accordion('Image-коннекты', `
        <div class="uris-server-connections">
            ${imageConnections.map(connection => renderServerConnectionForm(connection, { isActive: connection.id === state.activeImageProfileId })).join('')}
            <button class="uris-btn uris-btn-outline uris-add-btn" id="urisAddImageConn" type="button"><i class="fa-solid fa-plus"></i> Добавить коннект</button>
        </div>`, 'api:image-conn');

    const rerender = async () => {
        // probe / delete / add change which cards exist, so they need a full
        // host rebuild; preserve the scroll position so the user is not
        // teleported back to the top.
        const body = document.getElementById('urisBody');
        const sy = body?.scrollTop ?? 0, sx = body?.scrollLeft ?? 0;
        await renderImageConnSection(host);
        if (body) { body.scrollTop = sy; body.scrollLeft = sx; }
    };
    // Make a connection the active one. Persists to per-chat config; other tabs
    // observe the new active profile lazily on their own next render (they read
    // state.activeImageProfileId). We deliberately do NOT re-mount the API tab
    // here: a full rebuild would discard in-progress edits / scroll position in
    // neighbouring cards. The accent bar and the body "activate" button are
    // synced imperatively instead.
    const setActive = async id => {
        if (!id) return;
        const changed = state.activeImageProfileId !== id;
        await patchChatConfig({
            imageProfileId: id,
            ...(changed ? { generationDefaults: { modelId: null } } : {}),
        });
        state.activeImageProfileId = id;
        if (changed) {
            state.generationDefaults = { ...(state.generationDefaults || {}), modelId: null };
            window.dispatchEvent?.(new CustomEvent('uris:chat-generation-defaults-changed'));
        }
        for (const card of host.querySelectorAll('.uris-server-connection')) {
            const isActive = card.dataset.id === id;
            card.classList.toggle('uris-server-active', isActive);
            // Sync the body "activate" button (disabled + label) without a
            // full re-render; the radio fill follows from .uris-server-active.
            const btn = card.querySelector('.uris-server-activate');
            if (btn) {
                btn.disabled = isActive;
                btn.title = isActive ? 'Уже активен' : 'Сделать активным';
                const label = btn.querySelector('.uris-activate-label');
                if (label) label.textContent = isActive ? 'Активен' : 'Сделать активным';
            }
        }
    };
    for (const form of host.querySelectorAll('.uris-server-connection')) {
        const id = form.dataset.id;
        const draft = imageConnections.find(connection => connection.id === id);
        if (!draft) continue;
        bindServerConnectionForm(form, draft, {
        rerender,
        onSaved: () => rerenderCard(form, draft, rerender, setActive),
        rerenderCard: () => rerenderCard(form, draft, rerender, setActive),
        notifyError: error => {
            recordUrisError({ scope: 'API', message: error?.message || String(error) });
            toastr?.error(error?.message || String(error));
        },
        notifySuccess: message => toastr?.success(message),
        cloneConnection: cloneConnectionTemplate,
        setActive,
    });
    }

    host.querySelector('#urisAddImageConn').addEventListener('click', async () => {
        const { createConnection } = await import('../connections.js');
        await createConnection({
            name: 'Новый коннект', endpoint: '', timeoutMs: 120000,
        });
        await rerender();
    });
}

/** Clone a connection card: endpoint/model/settings copy, the key is re-entered. */
async function cloneConnectionTemplate(data) {
    const { createConnection } = await import('../connections.js');
    return createConnection({
        name: data.name,
        endpoint: data.endpoint,
        timeoutMs: 120000,
        model: data.model || null,
        overrides: data.overrides || {},
        extraBody: data.extraBody || {},
    });
}

function accordion(title, inner, id = '') {
    const idAttr = id ? ` data-accordion-id="${escapeHtml(id)}"` : '';
    return `<h4 class="uris-acc-header"${idAttr}>${escapeHtml(title)}</h4><div class="uris-acc-body">${inner}</div>`;
}
