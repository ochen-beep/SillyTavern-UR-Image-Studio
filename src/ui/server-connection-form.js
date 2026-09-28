// @ts-check
/**
 * Connection card v2: endpoint + key + «Проверить» + model.
 *
 * The dialect ("контракт маршрута") is no longer a user setting — it is
 * derived at dispatch time by dispatch-plan.js. The card shows the derived
 * facts (auth, delivery, model list) from the last probe and hides every
 * override in a collapsed «Расширенные» section for the cases where
 * auto-resolution misfires.
 */
import { deleteConnection, saveConnection } from '../connections.js';
import { getConnectionApiKey, setConnectionApiKey } from '../connection-store.js';
import { probeConnection } from '../connect-probe.js';
import { CONTRACTS, normalizeEndpoint, normalizeConnectionTimeoutMs, CONNECTION_TIMEOUT_DEFAULT_MS } from '../image-connection-schema.js';
import { deliveryHintFor, editDialectHintFor, clearDeliveryEvidenceFor } from '../delivery-evidence.js';
import { getProviderDescriptor } from '../provider-descriptors.js';
import { validatePollinationsToken } from '../providers/image-pollinations.js';
import { validateNaisteraToken } from '../providers/image-naistera.js';
import { getVisibleModelChoices, partitionLikelyImageModels } from '../dispatch-plan.js';
import { recordUrisError } from '../error-pool.js';
import { showConfirmModal, log, escapeHtml } from '../core.js';
import { forgetAccordion, getAccordionOpen, setAccordionOpen } from './accordion-state.js';
import { setStatus } from './window.js';

const MANUAL_MODEL = '__manual__';
const accordionId = id => `api:image-conn:${id}`;
const advancedId = id => `api:image-conn-advanced:${id}`;

const DIALECT_OPTIONS = [
    ['', 'Авто (рекомендуется)'],
    [CONTRACTS.CHAT_COMPLETIONS, 'chat-completions (image_url)'],
    [CONTRACTS.GEMINI_NATIVE, 'gemini-native (inlineData)'],
    [CONTRACTS.OPENAI_IMAGES, 'openai-images (generations/edits)'],
    [CONTRACTS.OPENROUTER_IMAGES, 'openrouter-images'],
    [CONTRACTS.POLLINATIONS_IMAGES, 'Pollinations (sk_ token)'],
    [CONTRACTS.NAISTERA, 'Naistera (токен из Telegram-бота)'],
];

function modelPartition(draft) {
    return partitionLikelyImageModels(
        Array.isArray(draft?.detected?.modelIds) ? draft.detected.modelIds : [],
        Array.isArray(draft?.detected?.modelMetadata) ? draft.detected.modelMetadata : [],
    );
}

/**
 * The dropdown list: likely-image models by default (gateways list hundreds
 * of text models); unknown entries remain available through manual model IDs.
 * An empty image classification is intentionally empty;
 * it must not silently turn a text catalog into an image catalog.
 */
function sortedModelIds(draft) {
    return getVisibleModelChoices(
        Array.isArray(draft?.detected?.modelIds) ? draft.detected.modelIds : [],
        {
            metadata: Array.isArray(draft?.detected?.modelMetadata) ? draft.detected.modelMetadata : [],
        },
    ).ids;
}

function ageLabel(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms) || ms < 0) return '';
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return 'только что';
    if (minutes < 60) return `${minutes} мин назад`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} ч назад`;
    return `${Math.round(hours / 24)} дн назад`;
}

function factsLine(draft) {
    const detected = draft?.detected;
    const parts = [];
    if (detected?.checkedAt) {
        const auth = detected.auth === 'x-goog-api-key' ? 'x-goog-api-key'
            : detected.auth === 'pollinations-sk' ? 'Pollinations sk_'
                : detected.auth === 'pollinations-public' ? 'публичный каталог'
                    : detected.auth === 'naistera-bearer' ? 'Naistera токен'
                        : 'Bearer';
        const delivery = detected.delivery === 'proxy' ? 'через прокси ST' : 'без прокси';
        const count = Array.isArray(detected.modelIds) ? detected.modelIds.length : 0;
        const imageCount = modelPartition(draft).imageModels.length;
        const modelsLabel = imageCount > 0
            ? `${imageCount} image-модел${imageCount % 10 === 1 && imageCount % 100 !== 11 ? 'ь' : 'ей'}${count > imageCount ? ` из ${count}` : ''}`
            : `${count} модел${count % 10 === 1 && count % 100 !== 11 ? 'ь' : 'ей'} (image не распознаны)`;
        const age = ageLabel(detected.checkedAt);
        parts.push([`✓ Подключено · ${modelsLabel} · ${auth} · ${delivery}`, detected.generationUnverified === true ? 'генерация не проверена' : '', detected.partial === true ? 'каталог получен частично — поток оборвался' : '', age ? `проверено ${age}` : ''].filter(Boolean).join(' · '));
    }
    // POST-доставка (опыт реальных генераций) может расходиться с GET-фактом
    // пробы: шлюз отвечает на прямой GET каталога, но режет прямой POST.
    // Показываем только активный «сломан» — тихий прямой успех фактом не является.
    if (deliveryHintFor(draft) === 'proxy' && draft?.deliveryEvidence?.directBrokenAt) {
        parts.push(`POST: авто→прокси (прямая не отвечала ${ageLabel(draft.deliveryEvidence.directBrokenAt) || 'только что'})`);
    }
    // Выученный диалект редактирования (openai-images + референсы).
    const editHint = editDialectHintFor(draft);
    if (editHint === 'img2img-proxy') parts.push('Редактирование: авто→generations+image');
    else if (editHint === 'json-proxy') parts.push('Редактирование: авто→JSON через прокси');
    const evidence = draft?.model?.id ? draft.evidence?.[draft.model.id] : null;
    if (evidence?.refs === 'confirmed') parts.push(`референсы: подтверждены${Number.isInteger(evidence.n) ? ` (${evidence.n})` : ''}`);
    else if (evidence?.refs === 'rejected') parts.push(`референсы: отклонены${evidence.reason ? ` — ${evidence.reason}` : ''}`);
    if (!parts.length) return 'Не проверено — нажмите «Проверить»';
    return parts.join(' · ');
}

function headerSummary(draft) {
    return draft?.model?.id || 'модель не выбрана';
}

// Readiness dot: green honestly means "would validate". amber = endpoint/key
// ok but never probed; red = not usable yet.
function headerStatus(draft) {
    if (draft?.errorMessage) return { state: 'red', label: draft.errorMessage };
    const hasEndpoint = !!draft?.endpoint?.trim();
    const needsKey = !draft?.id; // existing connections keep their key in separate storage
    const hasKey = !!draft?.apiKey?.trim();
    const hasModel = !!draft?.model?.id;
    const explicitPollinations = draft?.overrides?.dialect === CONTRACTS.POLLINATIONS_IMAGES;
    const inferredPollinations = /(?:^|\.)pollinations\.ai(?:\/|$)/i.test(String(draft?.endpoint || ''));
    const pollinations = explicitPollinations || inferredPollinations;
    if (pollinations && hasKey) {
        try { validatePollinationsToken(draft.apiKey); }
        catch (error) { return { state: 'red', label: error?.message || 'Требуется корректный sk_ токен Pollinations' }; }
    }
    const pollinationsNeedsKey = pollinations && !hasKey;
    const explicitNaistera = draft?.overrides?.dialect === CONTRACTS.NAISTERA;
    const inferredNaistera = /(?:^|[/.\-])naistera\.org(?:\/|$)/i.test(String(draft?.endpoint || ''));
    const naistera = explicitNaistera || inferredNaistera;
    if (naistera && hasKey) {
        try { validateNaisteraToken(draft.apiKey); }
        catch (error) { return { state: 'red', label: error?.message || 'Требуется токен Naistera' }; }
    }
    const naisteraNeedsKey = naistera && !hasKey;
    if (!hasEndpoint || (needsKey && !hasKey) || pollinationsNeedsKey || naisteraNeedsKey || !hasModel) {
        return { state: 'red', label: pollinationsNeedsKey ? 'Требуется sk_ токен Pollinations' : naisteraNeedsKey ? 'Требуется токен Naistera' : 'Не настроено' };
    }
    if (!draft?.detected?.checkedAt) return { state: 'amber', label: 'Не проверено' };
    if (draft.detected.generationUnverified === true) return { state: 'amber', label: 'Каталог доступен; генерация не проверена' };
    return { state: 'green', label: 'Готов' };
}

function modelSelectMarkup(draft) {
    const ids = sortedModelIds(draft);
    const current = draft?.model?.id || '';
    const classifications = modelPartition(draft).classifications;
    const classificationById = new Map(classifications.map(item => [item.modelId.toLowerCase(), item]));
    // Manual mode — только явный выбор пользователя (source:'manual') или
    // полное отсутствие модели. Инцидент 2026-09-28: «Сбросить знания»
    // опустошает detected.modelIds, из-за !ids.includes(current) карточка
    // уезжала в manual-режим, и следующий автосейв закреплял
    // source:'manual' в записи, хотя модель была выбрана из списка.
    const manualMode = !current || draft?.model?.source === 'manual';
    const options = ids.map(id => {
        const classification = classificationById.get(id.toLowerCase());
        const disabled = classification?.kind === 'non-image';
        const label = disabled ? `${id} (не image)` : id;
        return `<option value="${escapeHtml(id)}" ${!manualMode && id === current ? 'selected' : ''}${disabled ? ' disabled' : ''}>${escapeHtml(label)}</option>`;
    });
    // Модель выбрана из списка, но список (временно) пуст или её там нет —
    // показываем её в select отдельным option, чтобы выбор не «терял» вид.
    if (!manualMode && current && !ids.includes(current)) {
        options.unshift(`<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>`);
    }
    return `<select class="text_pole uris-server-model">${options.join('')}
        <option value="${MANUAL_MODEL}" ${manualMode ? 'selected' : ''}>— ввести ID вручную —</option>
    </select>`;
}

/** Dynamic placeholder for the manual id input: a real image model from this gateway. */
function manualModelPlaceholder(draft) {
    return modelPartition(draft).imageModels[0] || 'ID модели';
}

function selected(value, current) {
    return value === current ? ' selected' : '';
}

export function renderServerConnectionForm(draft = {}, options = {}) {
    const existing = Boolean(draft.id);
    const collapsed = existing ? !getAccordionOpen(accordionId(draft.id), false) : false;
    const advancedOpen = existing ? getAccordionOpen(advancedId(draft.id), false) : false;
    const timeoutSeconds = Number.isSafeInteger(draft.timeoutMs) ? draft.timeoutMs / 1000 : CONNECTION_TIMEOUT_DEFAULT_MS / 1000;
    const status = headerStatus(draft);
    const activeClass = options.isActive ? ' uris-server-active' : '';
    const overrides = draft.overrides || {};
    const extraBodyText = overrides.__extraBodyError ? overrides.__extraBodyError : JSON.stringify(draft.extraBody || {}, null, 2);
    const ids = sortedModelIds(draft);
    const current = draft?.model?.id || '';
    const manualMode = !current || draft?.model?.source === 'manual' || !ids.includes(current);
    const refsMode = overrides.refs || 'auto';
    const defaultEndpoint = getProviderDescriptor(overrides.dialect)?.defaultEndpoint || '';
    const endpoint = draft.endpoint || defaultEndpoint;
    return `<div class="uris-preset-card uris-server-connection${collapsed ? ' uris-collapsed' : ''}${activeClass}" data-id="${escapeHtml(draft.id || draft.draftId || '')}">
        <div class="uris-preset-card-header">
            <button class="uris-server-status uris-status-${status.state}" type="button" title="${escapeHtml(status.label)}" aria-label="Сделать активным. Статус: ${escapeHtml(status.label)}"></button>
            <input class="text_pole uris-server-name" value="${escapeHtml(draft.name || '')}" placeholder="Имя коннекта" aria-label="Имя коннекта">
            <button class="uris-name-edit" type="button" title="Переименовать" aria-label="Переименовать"><i class="fa-solid fa-pencil"></i></button>
            <span class="uris-server-route-summary">${escapeHtml(headerSummary(draft))}</span>
        </div>
        <div class="uris-preset-card-body">
            <div class="uris-row"><label>Адрес</label><input class="text_pole uris-server-endpoint" type="url" value="${escapeHtml(endpoint)}" placeholder="https://api.example.com/v1"></div>
            <div class="uris-row"><label>Ключ</label><input class="text_pole uris-server-api-key" type="password" value="${escapeHtml(draft.apiKey || '')}" placeholder="${escapeHtml(overrides.dialect === CONTRACTS.POLLINATIONS_IMAGES ? 'sk_...' : overrides.dialect === CONTRACTS.NAISTERA ? 'Токен из Telegram-бота' : 'Ключ API')}"></div>
            <div class="uris-server-probe-row">
                <button class="uris-btn uris-btn-confirm uris-server-probe" type="button">Проверить</button>
                <span class="uris-server-facts">${escapeHtml(factsLine(draft))}</span>
            </div>
            ${draft.errorMessage ? `<div class="uris-server-warning">${escapeHtml(draft.errorMessage)}</div>` : ''}
            <div class="uris-row"><label>Модель</label>${modelSelectMarkup(draft)}</div>
            <div class="uris-row uris-server-manual-row" ${manualMode ? '' : 'hidden'}><label>ID модели</label><input class="text_pole uris-server-manual-model" value="${escapeHtml(manualMode ? current : '')}" placeholder="${escapeHtml(manualModelPlaceholder(draft))}"></div>
            <details class="uris-advanced uris-server-advanced" ${advancedOpen ? 'open' : ''}>
                <summary>Расширенные</summary>
                <div class="uris-row"><label>Протокол</label><select class="text_pole uris-server-dialect" title="Как говорить с этим шлюзом. Авто определяет протокол по адресу и модели — меняйте только если Авто отправляет не тем протоколом.">${DIALECT_OPTIONS.map(([value, label]) => `<option value="${escapeHtml(value)}"${selected(value, overrides.dialect || '')}>${escapeHtml(label)}</option>`).join('')}</select></div>
                <div class="uris-row"><label>Редактирование</label><select class="text_pole uris-server-edit-protocol" title="Диалект /v1/images/edits для референсов. Авто: multipart напрямую; при CORS-блоке (доказанном OPTIONS-пробой) — JSON через прокси ST, затем generations+image (img2img); рабочий диалект запоминается на ~30 минут. JSON/img2img — принудительно один диалект."><option value=""${selected('', overrides.editProtocol || '')}>Авто</option><option value="multipart"${selected('multipart', overrides.editProtocol || '')}>multipart/form-data</option><option value="json"${selected('json', overrides.editProtocol || '')}>JSON (base64)</option></select></div>
                <div class="uris-row"><label>Параметры изображений Chat Completions</label><select class="text_pole uris-server-chat-image-config" title="Как передавать пропорцию и размер картинки в Chat Completions. OpenRouter — image_config + modalities. new-api (релейные шлюзы) — extra_body.google.image_config: без него шлюз молча вернёт свой дефолтный формат. Авто — не отправлять (соотношение уйдёт с предупреждением)."><option value=""${selected('', overrides.chatCompletionsImageConfig || '')}>Авто (не отправлять)</option><option value="new-api"${selected('new-api', overrides.chatCompletionsImageConfig || '')}>extra_body.google.image_config (шлюзы на new-api)</option><option value="openrouter"${selected('openrouter', overrides.chatCompletionsImageConfig || '')}>image_config (OpenRouter-совместимый)</option></select></div>
                <div class="uris-row"><label>Доставка</label><select class="text_pole uris-server-delivery" title="Авто: сначала напрямую; если прямая доставка не отвечала (или проба показала прокси) — через прокси ST, и следующие ~30 минут генерации идут через прокси без повторных неудач, пока прямая не проверится снова. «Через прокси» — всегда через SillyTavern. «Только напрямую» — никогда не проксировать. Отмена генерации при доставке через прокси не прерывает запрос у провайдера."><option value=""${selected('', overrides.delivery || '')}>Авто</option><option value="proxy"${selected('proxy', overrides.delivery || '')}>Через CORS-прокси ST</option><option value="direct"${selected('direct', overrides.delivery || '')}>Только напрямую</option></select></div>
                ${overrides.delivery === 'proxy' ? '<div class="uris-server-warning">«Остановить» при доставке через прокси ST прекращает только ожидание: запрос у провайдера продолжится и будет оплачен (прокси SillyTavern не передаёт отмену).</div>' : ''}
                <div class="uris-row"><label>Референсы</label><select class="text_pole uris-server-refs-mode"><option value="auto"${selected('auto', refsMode)}>Авто</option><option value="always"${selected('always', refsMode)}>Всегда отправлять</option><option value="never"${selected('never', refsMode)}>Никогда не отправлять</option></select></div>
                <div class="uris-row"><label>Лимит референсов</label><input class="text_pole uris-server-refs-max" type="number" min="0" step="1" value="${overrides.maxRefs ?? ''}" placeholder="авто"></div>
                <div class="uris-row"><label>Таймаут (сек)</label><input class="text_pole uris-server-timeout" type="number" min="15" max="600" step="1" value="${escapeHtml(timeoutSeconds)}"></div>
                <div class="uris-row"><label>Доп. параметры body (JSON)</label><textarea class="text_pole uris-server-extra-body" rows="3" placeholder='{"temperature": 0.7}' spellcheck="false">${escapeHtml(extraBodyText)}</textarea></div>
                <div class="uris-row"><button class="uris-btn uris-btn-ghost uris-server-forget" type="button" title="Забыть результаты проверки и факт-записи о генерациях на этом шлюзе">Сбросить знания о шлюзе</button></div>
            </details>
            <div class="uris-server-actions">
                <button class="uris-btn uris-btn-confirm uris-server-activate" type="button" ${options.isActive ? 'disabled title="Уже активен"' : 'title="Сделать активным"'}><i class="fa-solid fa-check"></i> <span class="uris-activate-label">${options.isActive ? 'Активен' : 'Сделать активным'}</span></button>
                <button class="uris-btn uris-btn-ghost uris-server-clone" type="button" title="Создать копию: тот же адрес и модель, ключ вводится заново">Клонировать</button>
                <button class="uris-btn uris-btn-ghost uris-server-delete" type="button">Удалить</button>
            </div>
        </div>
    </div>`;
}

function parseExtraBody(text) {
    const raw = String(text || '').trim();
    if (!raw) return { value: {} };
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { value: {}, error: 'Доп. параметры: ожидается JSON-объект, например {"key": "value"}' };
        }
        return { value: parsed };
    } catch {
        return { value: {}, error: 'Доп. параметры: некорректный JSON' };
    }
}

export function collectServerConnectionForm(form, previous = {}) {
    const value = selector => form.querySelector(selector)?.value ?? '';
    const timeoutSeconds = value('.uris-server-timeout');
    const timeoutMs = timeoutSeconds === '' ? NaN : Number(timeoutSeconds) * 1000;
    const selectValue = value('.uris-server-model');
    const manualValue = value('.uris-server-manual-model').trim();
    const model = selectValue === MANUAL_MODEL
        ? (manualValue ? { id: manualValue, source: 'manual' } : null)
        : { id: selectValue, source: 'list' };
    const overrides = { ...(previous.overrides || {}) };
    const dialect = value('.uris-server-dialect');
    if (dialect) overrides.dialect = dialect; else delete overrides.dialect;
    const editProtocol = value('.uris-server-edit-protocol');
    if (editProtocol) overrides.editProtocol = editProtocol; else delete overrides.editProtocol;
    const chatImageConfig = value('.uris-server-chat-image-config');
    if (chatImageConfig) overrides.chatCompletionsImageConfig = chatImageConfig;
    else delete overrides.chatCompletionsImageConfig;
    const delivery = value('.uris-server-delivery');
    if (delivery) overrides.delivery = delivery; else delete overrides.delivery;
    const refs = value('.uris-server-refs-mode');
    if (refs && refs !== 'auto') overrides.refs = refs; else delete overrides.refs;
    const maxRefsRaw = value('.uris-server-refs-max');
    if (maxRefsRaw === '') delete overrides.maxRefs;
    else overrides.maxRefs = Number(maxRefsRaw);
    delete overrides.__extraBodyError;
    const extra = parseExtraBody(value('.uris-server-extra-body'));
    if (extra.error) overrides.__extraBodyError = value('.uris-server-extra-body');
    return {
        ...previous,
        name: value('.uris-server-name').trim(),
        endpoint: normalizeEndpoint(value('.uris-server-endpoint')),
        timeoutSeconds,
        timeoutMs,
        apiKey: value('.uris-server-api-key').trim(),
        model,
        overrides,
        extraBody: extra.value,
    };
}

function collectSavePayload(draft) {
    return {
        id: draft.id,
        name: draft.name,
        endpoint: draft.endpoint,
        timeoutMs: draft.timeoutMs,
        model: draft.model || null,
        overrides: draft.overrides || {},
        extraBody: draft.extraBody || {},
        // Probe facts and per-model evidence survive card edits.
        detected: draft.detected || null,
        evidence: draft.evidence || {},
        // Опыт доставки/диалекта живёт браузер-локально (delivery-evidence.js);
        // null вычищает легаси-поля старых записей при следующем сохранении.
        deliveryEvidence: null,
        editDialectEvidence: null,
        // The v2 card no longer persists discovered route lists; detected.
        // modelIds is the single source for the model dropdown.
        routes: [],
        catalog: undefined,
        selectedRouteId: null,
        manualModelId: undefined,
        apiFamilyOverride: draft.overrides?.dialect || '',
        routeFilter: undefined,
        useCorsProxy: draft.overrides?.delivery === 'proxy',
        editProtocol: draft.overrides?.editProtocol === 'json' ? 'json' : 'multipart',
    };
}

export function validateServerConnectionDraft(draft, options = {}) {
    try {
        if (draft?.timeoutSeconds === '' || (draft?.timeoutSeconds !== undefined && !/^\d+$/.test(String(draft.timeoutSeconds)))) throw new TypeError('invalid seconds');
        normalizeConnectionTimeoutMs(draft?.timeoutMs);
    }
    catch (error) { throw new TypeError(`timeoutMs: ${error.message}`); }
    if (options.purpose === 'probe') {
        if (!draft?.endpoint?.trim()) throw new TypeError('Endpoint is required');
        return draft;
    }
    if (!draft?.name?.trim()) throw new TypeError('Connection name is required');
    if (!draft?.endpoint?.trim()) throw new TypeError('Endpoint is required');
    if (!draft.id && !draft?.apiKey?.trim()) throw new TypeError('API key is required');
    if (!draft?.model?.id) throw new TypeError('Select a model (from the list or by ID) before saving');
    if (draft.overrides?.dialect === CONTRACTS.POLLINATIONS_IMAGES && draft.apiKey?.trim()) validatePollinationsToken(draft.apiKey);
    if (draft.overrides?.dialect === CONTRACTS.NAISTERA && draft.apiKey?.trim()) validateNaisteraToken(draft.apiKey);
    return draft;
}

export function bindServerConnectionForm(form, draft, dependencies = {}) {
    const update = dependencies.saveConnection || saveConnection;
    const remove = dependencies.deleteConnection || deleteConnection;
    const getKey = dependencies.getConnectionApiKey || getConnectionApiKey;
    const saveKey = dependencies.setConnectionApiKey || setConnectionApiKey;
    const probe = dependencies.probeConnection || probeConnection;
    const rerender = dependencies.rerender || (() => {});
    const rerenderCard = dependencies.rerenderCard || rerender;
    const notifyError = dependencies.notifyError || (() => {});
    const notifySuccess = dependencies.notifySuccess || (() => {});
    const confirmDelete = dependencies.confirmDelete || (async () => showConfirmModal('Удалить этот коннект? Действие необратимо.'));
    const cloneConnection = dependencies.cloneConnection || null;
    const saveDebounceMs = dependencies.saveDebounceMs ?? 400;
    const setActive = dependencies.setActive || (() => {});

    const sync = () => {
        Object.assign(draft, collectServerConnectionForm(form, draft));
    };
    const manualRow = () => form.querySelector('.uris-server-manual-row');
    const modelSelect = () => form.querySelector('.uris-server-model');

    let saveTimer;
    const doSave = async () => {
        // The API key lives in browser-local storage and is saved independently
        // so a metadata validation gap (e.g. mid-edit timeout) never blocks it.
        if (draft.id) {
            try { await saveKey(draft.id, draft.apiKey || ''); }
            catch (error) { draft.errorMessage = error?.message || 'API key save failed'; notifyError(error); }
        }
        try {
            await update(collectSavePayload(draft));
            dependencies.onSaved?.();
        } catch {
            // Auto-save skips invalid intermediate states silently; explicit
            // actions (probe) surface validation errors to the user.
        }
    };
    const scheduleSave = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(doSave, saveDebounceMs);
    };
    const onChange = () => { sync(); scheduleSave(); };

    form.querySelector('.uris-preset-card-header')?.addEventListener('click', event => {
        if (event.target?.closest?.('input, select, textarea, button')) return;
        const willCollapse = !form.classList.contains('uris-collapsed');
        form.classList.toggle('uris-collapsed', willCollapse);
        if (draft.id) setAccordionOpen(accordionId(draft.id), !willCollapse);
    });

    form.querySelector('.uris-server-advanced')?.addEventListener('toggle', event => {
        if (draft.id) setAccordionOpen(advancedId(draft.id), event.target.open);
    });

    form.querySelector('.uris-server-status')?.addEventListener('click', async event => {
        event.stopPropagation();
        event.preventDefault();
        if (draft.id) await setActive(draft.id);
    });
    form.querySelector('.uris-server-activate')?.addEventListener('click', async () => {
        if (draft.id) await setActive(draft.id);
    });
    form.querySelector('.uris-name-edit')?.addEventListener('click', () => form.querySelector('.uris-server-name')?.focus());
    form.querySelector('.uris-server-name')?.addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

    for (const tag of ['input', 'select', 'textarea']) {
        for (const input of form.querySelectorAll(tag)) {
            if (input.classList.contains('uris-server-model')) continue; // has its own handler
            input.addEventListener('input', onChange);
            input.addEventListener('change', onChange);
        }
    }

    form.querySelector('.uris-server-dialect')?.addEventListener('change', () => {
        const dialect = form.querySelector('.uris-server-dialect')?.value || '';
        const endpointInput = form.querySelector('.uris-server-endpoint');
        const descriptor = getProviderDescriptor(dialect);
        if (descriptor?.defaultEndpoint && endpointInput && !endpointInput.value.trim()) {
            endpointInput.value = descriptor.defaultEndpoint;
        }
        sync();
        scheduleSave();
    });

    // Model select: list option saves immediately; the manual option only
    // reveals the ID input (the input's own handler persists it).
    modelSelect()?.addEventListener('change', () => {
        sync();
        const row = manualRow();
        const manual = modelSelect().value === MANUAL_MODEL;
        if (row) {
            if (manual) row.removeAttribute('hidden');
            else row.setAttribute('hidden', '');
        }
        if (manual) {
            row?.querySelector('.uris-server-manual-model')?.focus();
            return;
        }
        scheduleSave();
        rerenderCard();
    });

    form.querySelector('.uris-server-forget')?.addEventListener('click', async () => {
        draft.detected = null;
        draft.evidence = {};
        // Сброс и браузер-локальной памяти доставки/диалекта — следующая
        // генерация заново исследует прямую доставку и диалекты с чистого листа.
        await clearDeliveryEvidenceFor(draft.id);
        try {
            await update(collectSavePayload(draft));
            log('Connection facts reset', draft.id);
            rerenderCard();
        } catch (error) { notifyError(error); }
    });

    form.querySelector('.uris-server-clone')?.addEventListener('click', async () => {
        if (!cloneConnection) return;
        try {
            const created = await cloneConnection({
                name: `${draft.name || 'Коннект'} (копия)`,
                endpoint: draft.endpoint,
                model: draft.model || null,
                overrides: draft.overrides || {},
                extraBody: draft.extraBody || {},
            });
            notifySuccess(`Скопировано: ${created?.name || ''}. Введите ключ в новой карточке.`);
            await rerender();
        } catch (error) { notifyError(error); }
    });

    form.querySelector('.uris-server-probe')?.addEventListener('click', async () => {
        log('probe: click', draft?.id || draft?.draftId, 'endpoint=', draft?.endpoint, 'runtime=', 'catalog-v3');
        setStatus('Проверка подключения...');
        sync();
        form.querySelector('.uris-server-probe').disabled = true;
        try {
            validateServerConnectionDraft(draft, { purpose: 'probe' });
            const apiKey = draft.apiKey || (draft.id ? await getKey(draft.id) : '');
            const corsMode = draft.overrides?.delivery === 'proxy' ? 'proxy'
                : draft.overrides?.delivery === 'direct' ? 'direct' : 'auto';
            const outcome = await probe({
                endpoint: draft.endpoint, apiKey, timeoutMs: draft.timeoutMs, corsMode,
            });
            draft.detected = outcome;
            draft.errorMessage = '';
            await update(collectSavePayload(draft));
            log('probe: ok', draft.id, outcome.modelIds.length, 'models', outcome.apiShape, outcome.auth, outcome.delivery, 'source=', outcome.catalogSource || 'unknown', 'url=', outcome.catalogUrl || 'unknown', 'metadata=', outcome.metadataCount ?? (outcome.modelMetadata?.length || 0), 'partial=', outcome.partial === true);
            notifySuccess(`Подключено: ${outcome.modelIds.length} моделей (${outcome.apiShape})`);
            rerenderCard();
            setStatus('');
        } catch (error) {
            log('probe: fail', draft?.id || draft?.draftId, error?.code || '', error?.message || error);
            draft.errorMessage = error?.message || 'Проверка не удалась';
            recordUrisError({ scope: 'Проверка', message: `${draft?.name || draft?.endpoint || 'коннект'}: ${draft.errorMessage}` });
            notifyError(error);
            rerenderCard();
            setStatus('');
        } finally {
            const btn = form.querySelector('.uris-server-probe');
            if (btn) btn.disabled = false;
        }
    });

    form.querySelector('.uris-server-delete')?.addEventListener('click', async () => {
        const confirmed = await confirmDelete();
        if (!confirmed) return;
        try {
            if (draft.id) {
                await remove(draft.id);
                if (draft.id) forgetAccordion(accordionId(draft.id));
            }
        } catch (error) {
            notifyError(error);
            rerenderCard();
            return;
        }
        await rerender();
    });
}
