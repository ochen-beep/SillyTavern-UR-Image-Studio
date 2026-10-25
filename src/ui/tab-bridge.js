// @ts-check
/**
 * Experimental "Bridge" tab (visible only when settings.bridgeTab is on):
 * a lab for the external-bridge surface — manual generate calls, the reference
 * pool, capabilities and read-surface (triggers / gallery / recovery), exactly
 * as an external extension would issue them via globalThis.URIS.
 * (The headless Stage-1 lab was removed — buildPrompt stays available through
 * the bridge API and its tests.)
 */
import { state, escapeHtml, DISPLAY_NAME, error } from '../core.js';
import { getBridge } from '../bridge.js';
import { VALID_ASPECT_RATIOS } from '../core.js';
import { reportFailure, URIS_SCOPES } from '../error-pool.js';

// Module-scoped form state: survives tab re-renders within the session.
const _lab = {
    caller: 'bridge-test',
    statusText: 'Статус: неизвестен.',
    // Generation lab
    prompt: '',
    autoRefs: false,
    refIds: new Set(),
    aspect: '1:1',
    connectionId: '',
    running: false,
    refs: null,          // cache: [{id,name,folders,bindingMode}]
    connections: null,   // cache: [{id,label,modelId,ready}]
    ctl: null,
    resultHtml: '',
    // Read-surface lab (v0.9.6): triggers, capabilities, gallery, recovery
    triggers: null,      // cache: [{id,name,aliases,aspect,refsPolicy}]
    capsText: '',
    gallery: null,       // cache: [{id,imagePath,thumbPath,prompt,status,…}]
    galleryText: '',
    pending: null,       // cache: [{requestId,status,createdAt,prompt,…}]
    pendingText: '',
};

/** Live root of the rendered tab; lets module-level event handlers repaint. */
let _labRoot = null;
let _bridgeEventsWired = false;

/** @param {HTMLElement} root */
export function render(root) {
    if (!state.settings) {
        root.innerHTML = '<div class="uris-settings"><small class="uris-hint">Настройки ещё не загружены.</small></div>';
        return;
    }
    root.innerHTML = `
        <div class="uris-settings">
            <small class="uris-hint">Лаборатория моста: те же вызовы, что делает стороннее расширение через globalThis.URIS — генерация, референсы и чтение состояния. Включается тумблером «Показывать вкладку „Мост"» в Настройках. Контракт API: <a href="https://github.com/ochen-beep/SillyTavern-UR-Image-Studio/blob/main/docs/guide/bridge-api.md" target="_blank" rel="noopener noreferrer">docs/guide/bridge-api.md</a>.</small>

            <section class="uris-settings-section">
                <h3>Статус</h3>
                <small class="uris-hint" id="urisLabStatus">${escapeHtml(_lab.statusText)}</small>
                <div class="uris-settings-actions">
                    <button type="button" class="uris-btn uris-btn-ghost" id="urisLabRefresh"><i class="fa-solid fa-rotate"></i> Обновить</button>
                </div>
            </section>

            <section class="uris-settings-section">
                <h3>Генерация как внешнее расширение</h3>
                <div class="uris-field">
                    <label for="urisLabPrompt">Промпт для картинки</label>
                    <textarea class="text_pole" id="urisLabPrompt" rows="3">${escapeHtml(_lab.prompt)}</textarea>
                </div>
                <label class="checkbox_label"><input type="checkbox" id="urisLabAutoRefs" ${_lab.autoRefs ? 'checked' : ''}><span>Авто-подбор референсов по промпту (резолвер Stage 2)</span></label>
                <div class="uris-field">
                    <label>Референсы из пула URIS</label>
                    <div id="urisLabRefs" class="uris-lab-box uris-lab-refs">
                        ${(_lab.refs || []).map(ref => `
                            <label class="checkbox_label"><input type="checkbox" data-ref-id="${escapeHtml(ref.id)}" ${_lab.refIds.has(ref.id) ? 'checked' : ''}><span>${escapeHtml(ref.name)}</span></label>`).join('') || '<small class="uris-hint">Пул пуст.</small>'}
                    </div>
                    <small class="uris-hint">Отмеченные уйдут как references [{refId}] — мост сам возьмёт картинку из пула.</small>
                </div>
                <div class="uris-field">
                    <label for="urisLabAspect">Формат</label>
                    <select class="text_pole" id="urisLabAspect">${VALID_ASPECT_RATIOS.map(ar => `<option value="${ar}"${ar === _lab.aspect ? ' selected' : ''}>${ar}</option>`).join('')}</select>
                </div>
                <div class="uris-field">
                    <label for="urisLabConn">Соединение</label>
                    <select class="text_pole" id="urisLabConn">
                        <option value="">как в текущем чате</option>
                        ${(_lab.connections || []).map(c => `<option value="${escapeHtml(c.id)}"${c.id === _lab.connectionId ? ' selected' : ''}>${escapeHtml(c.label)}${c.ready ? '' : ' (не готово)'}</option>`).join('')}
                    </select>
                </div>
                <div class="uris-field">
                    <label for="urisLabCaller">Caller (кто просит)</label>
                    <input type="text" class="text_pole" id="urisLabCaller" maxlength="64" value="${escapeHtml(_lab.caller)}">
                </div>
                <div class="uris-settings-actions">
                    <button type="button" class="uris-btn uris-btn-outline" id="urisLabRun"${_lab.running ? ' disabled' : ''}><i class="fa-solid fa-image"></i> Сгенерировать</button>
                    <button type="button" class="uris-btn uris-btn-ghost" id="urisLabAbort"${_lab.running ? '' : ' hidden'}><i class="fa-solid fa-stop"></i> Отменить</button>
                </div>
                <small class="uris-hint" id="urisLabOut">${_lab.running ? 'Генерация…' : 'Готово к вызову.'}</small>
                <div id="urisLabPreview">${_lab.resultHtml}</div>
            </section>

            <section class="uris-settings-section">
                <h3>Возможности соединения <small class="uris-hint">(getCapabilities)</small></h3>
                <small class="uris-hint">Что URIS знает о выбранном соединении ДО платного вызова: контракт, референсы, известные размеры/качества.</small>
                <div class="uris-settings-actions">
                    <button type="button" class="uris-btn uris-btn-ghost" id="urisLabCaps"><i class="fa-solid fa-list-check"></i> Показать возможности</button>
                </div>
                <small class="uris-hint uris-pre" id="urisLabCapsOut">${escapeHtml(_lab.capsText)}</small>
            </section>

            <section class="uris-settings-section">
                <h3>Триггер-профили <small class="uris-hint">(listTriggers)</small></h3>
                <div id="urisLabTriggers">${_labTriggersHtml()}</div>
            </section>

            <section class="uris-settings-section">
                <h3>Галерея caller'а <small class="uris-hint">(listGallery + removeCard)</small></h3>
                <small class="uris-hint">Карточки с provenance.requestId = ext_&lt;caller&gt;_…. Удаление скоупнуто: чужие и ручные карточки мост удалить не даст (CARD_NOT_OWNED); файл на диске остаётся.</small>
                <small class="uris-hint" id="urisLabGalleryOut">${escapeHtml(_lab.galleryText)}</small>
                <div id="urisLabGallery" class="uris-flex-wrap">${_labGalleryHtml()}</div>
            </section>

            <section class="uris-settings-section">
                <h3>Recovery <small class="uris-hint">(listPending)</small></h3>
                <small class="uris-hint">Платные запросы, чей исход URIS не подтвердил (вкладка закрылась, обрыв после POST). Автоматически не пересылаются — это список ручного разбора.</small>
                <small class="uris-hint" id="urisLabPendingOut">${escapeHtml(_lab.pendingText)}</small>
                <div id="urisLabPending">${_labPendingHtml()}</div>
            </section>
        </div>`;
    bindLab(root);
}

function _labTriggerChip(t) {
    return `<span class="uris-tpl-chip" title="${escapeHtml(t.aliases.join(', '))}">${escapeHtml(t.id)} · ${escapeHtml(t.aspect)}${t.refsPolicy === 'off' ? ' · refs off' : ''}</span>`;
}

function _labTriggersHtml() {
    if (!_lab.triggers) return '<small class="uris-hint">Не загружено.</small>';
    if (!_lab.triggers.length) return '<small class="uris-hint">Реестр пуст.</small>';
    return _lab.triggers.map(_labTriggerChip).join('');
}

function _labGalleryHtml() {
    if (!_lab.gallery) return '<small class="uris-hint">Не загружено.</small>';
    if (!_lab.gallery.length) return '<small class="uris-hint">Карточек этого caller пока нет.</small>';
    return _lab.gallery.map(card => `
        <div class="uris-lab-card">
            <img class="uris-lab-card-img${card.status === 'missing' ? ' uris-is-missing' : ''}" src="/${escapeHtml(card.thumbPath || card.imagePath || '')}" alt="" title="${escapeHtml(card.prompt.slice(0, 200))}">
            <button type="button" class="uris-btn uris-btn-ghost uris-lab-card-del" data-card-id="${escapeHtml(card.id)}" title="removeCard (только свои карточки)">×</button>
        </div>`).join('');
}

function _labPendingHtml() {
    if (!_lab.pending) return '<small class="uris-hint">Не загружено.</small>';
    if (!_lab.pending.length) return '<small class="uris-hint">Неподтверждённых платных запросов нет.</small>';
    return _lab.pending.map(rec => `
        <div class="uris-lab-box">
            <small><code>${escapeHtml(rec.requestId)}</code> — ${escapeHtml(rec.status)}${rec.error ? ` · ${escapeHtml(rec.error)}` : ''}</small><br>
            <small class="uris-hint">${escapeHtml(rec.createdAt || '')} · ${escapeHtml(rec.aspectRatio || '?')} · refs: ${rec.referenceCount}</small><br>
            <small class="uris-hint">${escapeHtml(rec.prompt.slice(0, 160))}${rec.prompt.length > 160 ? '…' : ''}</small>
        </div>`).join('');
}

/** Repaint gallery/pending when the bridge signals a change lab-wide. */
function wireBridgeEventsOnce() {
    if (_bridgeEventsWired || typeof window === 'undefined') return;
    _bridgeEventsWired = true;
    window.addEventListener('uris:bridge', (ev) => {
        const type = ev?.detail?.type;
        if (type !== 'gallery:added' && type !== 'gallery:removed') return;
        if (!_labRoot) return;
        refreshReadSurface(_labRoot, { gallery: true, pending: true }).catch(() => {});
    });
}

function labOut(root, text) {
    const el = root?.querySelector?.('#urisLabOut');
    if (el) el.textContent = text;
}

function labSetRunning(root, running) {
    _lab.running = running;
    const run = root?.querySelector?.('#urisLabRun');
    const abort = root?.querySelector?.('#urisLabAbort');
    if (run) run.disabled = running;
    if (abort) abort.hidden = !running;
}

/**
 * One-line error for the lab: code + classification + message, exactly the
 * fields an external consumer should be branching on.
 */
function formatBridgeError(e) {
    const code = e?.code ? ` [${e.code}${e?.category ? ` · ${e.category}` : ''}${e?.retryable ? ' · повторимо' : ''}]` : '';
    return `Ошибка${code}: ${e?.message || e}`;
}

function bindLab(root) {
    _labRoot = root;
    wireBridgeEventsOnce();
    root.querySelector('#urisLabRefresh')?.addEventListener('click', () => refreshLabData(root));
    root.querySelector('#urisLabPrompt')?.addEventListener('input', e => { _lab.prompt = e.target.value; });
    root.querySelector('#urisLabAutoRefs')?.addEventListener('change', e => { _lab.autoRefs = e.target.checked === true; });
    root.querySelector('#urisLabAspect')?.addEventListener('change', e => { _lab.aspect = e.target.value; });
    root.querySelector('#urisLabConn')?.addEventListener('change', e => { _lab.connectionId = e.target.value; });
    root.querySelector('#urisLabCaller')?.addEventListener('input', e => { _lab.caller = e.target.value; });
    root.querySelector('#urisLabRefs')?.addEventListener('change', e => {
        const id = e.target?.getAttribute?.('data-ref-id');
        if (!id) return;
        if (e.target.checked) _lab.refIds.add(id);
        else _lab.refIds.delete(id);
    });
    root.querySelector('#urisLabAbort')?.addEventListener('click', () => { _lab.ctl?.abort(); });

    root.querySelector('#urisLabCaps')?.addEventListener('click', async () => {
        const bridge = getBridge();
        if (!bridge) return;
        labOut(root, 'Читаю возможности соединения…');
        try {
            const caps = await bridge.getCapabilities(_lab.connectionId || undefined);
            _lab.capsText = [
                `connection: ${caps.label} [${caps.connectionId}]`,
                `model: ${caps.modelId || '—'} · contract: ${caps.contract || '—'} · ready: ${caps.ready}`,
                `generation: ${caps.imageGeneration} · references: ${caps.references}${caps.maxReferences != null ? ` (max ${caps.maxReferences})` : ''}`,
                `sizes: ${Array.isArray(caps.sizes) ? caps.sizes.join(', ') : 'неизвестно'} · qualities: ${Array.isArray(caps.qualities) ? caps.qualities.join(', ') : 'неизвестно'}`,
            ].join('\n');
            const out = root.querySelector('#urisLabCapsOut');
            if (out) out.textContent = _lab.capsText;
            labOut(root, 'Возможности получены.');
        } catch (e) {
            _lab.capsText = '';
            labOut(root, formatBridgeError(e));
        }
    });

    // Gallery delete: caller-scoped through the bridge (CARD_NOT_OWNED on foreign cards).
    root.querySelector('#urisLabGallery')?.addEventListener('click', async (event) => {
        const btn = event.target?.closest?.('[data-card-id]');
        const cardId = btn?.getAttribute?.('data-card-id');
        if (!cardId) return;
        const bridge = getBridge();
        if (!bridge) return;
        try {
            await bridge.removeCard(cardId, { caller: _lab.caller.trim() || 'bridge-test' });
            labOut(root, `Карточка ${cardId} удалена (файл на диске оставлен).`);
            refreshReadSurface(root, { gallery: true }).catch(() => {});
        } catch (e) {
            labOut(root, formatBridgeError(e));
        }
    });

    root.querySelector('#urisLabRun')?.addEventListener('click', async () => {
        const bridge = getBridge();
        if (!bridge || _lab.running) return;
        const prompt = _lab.prompt.trim();
        if (!prompt) { labOut(root, 'Промпт пуст — введите его вручную.'); return; }
        const references = [..._lab.refIds].map(refId => ({ refId }));
        const ctl = new AbortController();
        _lab.ctl = ctl;
        labSetRunning(root, true);
        _lab.resultHtml = '';
        const preview = root.querySelector('#urisLabPreview');
        if (preview) preview.innerHTML = '';
        try {
            const res = await bridge.generate(
                {
                    prompt,
                    aspectRatio: _lab.aspect,
                    connectionId: _lab.connectionId || undefined,
                    references,
                    useSceneRefs: _lab.autoRefs,
                },
                { caller: _lab.caller.trim() || 'bridge-test', signal: ctl.signal, onStatus: s => labOut(root, s) },
            );
            const img = `<img class="uris-media-img" src="/${escapeHtml(res.imagePath || '')}" alt="">`;
            _lab.resultHtml = img;
            if (preview) preview.innerHTML = img;
            labOut(root, `Готово [${res.requestId}]: ${res.width ?? '?'}×${res.height ?? '?'} · ${res.imagePath}`);
            refreshReadSurface(root, { gallery: true, pending: true }).catch(() => {});
        } catch (e) {
            labOut(root, formatBridgeError(e));
            error('bridge lab:', e);
        } finally {
            _lab.ctl = null;
            labSetRunning(root, false);
        }
    });

    // Async fills after render — never block the tab paint.
    refreshLabData(root).catch(e => {
        reportFailure({ scope: URIS_SCOPES.bridge, message: e?.message || String(e) });
    });
}

async function refreshLabData(root) {
    const bridge = getBridge();
    if (!bridge) {
        _lab.statusText = 'Мост не активен: расширение ещё инициализируется или выключено.';
        const el = root?.querySelector?.('#urisLabStatus');
        if (el) el.textContent = _lab.statusText;
        return;
    }
    try {
        const [status, refs, connections] = await Promise.all([
            bridge.getStatus(),
            bridge.listRefs().catch(() => null),
            bridge.listConnections().catch(() => null),
        ]);
        const conn = status.connection
            ? `${status.connection.label} (${status.connection.modelId || 'модель не выбрана'})`
            : 'нет';
        _lab.statusText = `apiVersion ${bridge.apiVersion} · ready=${status.ready}, accepting=${status.accepting}; соединение чата: ${conn}; в работе: ${status.active.length}.`;
        const el = root?.querySelector?.('#urisLabStatus');
        if (el) el.textContent = _lab.statusText;
        if (refs) {
            _lab.refs = refs;
            const box = root?.querySelector?.('#urisLabRefs');
            if (box) {
                box.innerHTML = refs.map(ref => `
                    <label class="checkbox_label"><input type="checkbox" data-ref-id="${escapeHtml(ref.id)}" ${_lab.refIds.has(ref.id) ? 'checked' : ''}><span>${escapeHtml(ref.name)}</span></label>`).join('')
                    || '<small class="uris-hint">Пул пуст.</small>';
            }
        }
        if (connections) {
            _lab.connections = connections;
            const sel = root?.querySelector?.('#urisLabConn');
            if (sel) {
                sel.innerHTML = '<option value="">как в текущем чате</option>'
                    + connections.map(c => `<option value="${escapeHtml(c.id)}"${c.id === _lab.connectionId ? ' selected' : ''}>${escapeHtml(c.label)}${c.ready ? '' : ' (не готово)'}</option>`).join('');
            }
        }
    } catch (e) {
        _lab.statusText = `Статус недоступен: ${e?.message || e}`;
        const el = root?.querySelector?.('#urisLabStatus');
        if (el) el.textContent = _lab.statusText;
    }
    // Read surface (triggers, gallery, pending) — не блокирует статус при сбое.
    refreshReadSurface(root, { triggers: true, gallery: true, pending: true }).catch(() => {});
}

/**
 * Fill the read-only labs: listTriggers / listGallery / listPending. Each
 * block degrades on its own — a failing read must not blank the others.
 */
async function refreshReadSurface(root, { triggers = false, gallery = false, pending = false } = {}) {
    const bridge = getBridge();
    if (!bridge) return;
    const caller = _lab.caller.trim() || 'bridge-test';
    if (triggers && typeof bridge.listTriggers === 'function') {
        try {
            _lab.triggers = await bridge.listTriggers();
            const box = root.querySelector('#urisLabTriggers');
            if (box) box.innerHTML = _labTriggersHtml();
        } catch { /* секция остаётся на прошлом значении */ }
    }
    if (gallery && typeof bridge.listGallery === 'function') {
        try {
            const page = await bridge.listGallery({ caller, limit: 12 });
            _lab.gallery = page.cards;
            _lab.galleryText = `listGallery({caller:"${caller}"}): показано ${page.cards.length} из ${page.total}.`;
        } catch (e) {
            _lab.galleryText = formatBridgeError(e);
        }
        const out = root.querySelector('#urisLabGalleryOut');
        if (out) out.textContent = _lab.galleryText;
        const box = root.querySelector('#urisLabGallery');
        if (box) box.innerHTML = _labGalleryHtml();
    }
    if (pending && typeof bridge.listPending === 'function') {
        try {
            _lab.pending = await bridge.listPending({ caller });
            _lab.pendingText = `listPending({caller:"${caller}"}): ${_lab.pending.length} записей.`;
        } catch (e) {
            _lab.pendingText = formatBridgeError(e);
        }
        const out = root.querySelector('#urisLabPendingOut');
        if (out) out.textContent = _lab.pendingText;
        const box = root.querySelector('#urisLabPending');
        if (box) box.innerHTML = _labPendingHtml();
    }
}
