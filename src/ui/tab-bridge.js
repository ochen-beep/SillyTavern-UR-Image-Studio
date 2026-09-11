// @ts-check
/**
 * Experimental "Bridge" tab (visible only when settings.bridgeTab is on):
 * a lab for the external-bridge surface — templates (headless Stage 1),
 * the reference pool, the scene resolver and manual bridge calls, exactly as
 * an external extension would issue them via globalThis.URIS.
 */
import { state, escapeHtml, DISPLAY_NAME, error } from '../core.js';
import { getBridge } from '../bridge.js';
import { VALID_ASPECT_RATIOS } from '../core.js';
import { recordUrisError } from '../error-pool.js';

// Module-scoped form state: survives tab re-renders within the session.
const _lab = {
    caller: 'bridge-test',
    statusText: 'Статус: неизвестен.',
    // Stage 1 lab
    templateId: '',
    sceneText: 'Пост в соцсети от {{char}}: собираемся на пляж на закате, лёгкое летнее платье, тёплое настроение.',
    useScene: true,
    builtPrompt: '',
    matchedLine: '',
    building: false,
    // Generation lab
    prompt: '',
    autoRefs: false,
    refIds: new Set(),
    aspect: '1:1',
    connectionId: '',
    running: false,
    templates: null,     // cache: [{id,name,type}]
    refs: null,          // cache: [{id,name,folders,bindingMode}]
    connections: null,   // cache: [{id,label,modelId,ready}]
    ctl: null,
    resultHtml: '',
};

/** @param {HTMLElement} root */
export function render(root) {
    if (!state.settings) {
        root.innerHTML = '<div class="uris-settings"><small class="uris-hint">Настройки ещё не загружены.</small></div>';
        return;
    }
    root.innerHTML = `
        <div class="uris-settings">
            <small class="uris-hint">Лаборатория моста: те же вызовы, что делает стороннее расширение через globalThis.URIS — шаблоны (Stage 1), референсы и резолвер сцены. Включается тумблером «Показывать вкладку „Мост"» в Настройках.</small>

            <section class="uris-settings-section">
                <h3>Статус</h3>
                <small class="uris-hint" id="urisLabStatus">${escapeHtml(_lab.statusText)}</small>
                <div class="uris-settings-actions">
                    <button type="button" class="uris-btn uris-btn-ghost" id="urisLabRefresh"><i class="fa-solid fa-rotate"></i> Обновить</button>
                </div>
            </section>

            <section class="uris-settings-section">
                <h3>Шаблон → промпт <small class="uris-hint">(headless Stage 1, платный текстовый запрос)</small></h3>
                <div class="uris-field">
                    <label for="urisLabTemplate">Шаблон URIS</label>
                    <select class="text_pole" id="urisLabTemplate">
                        <option value="">без шаблона (базовый режим)</option>
                        ${(_lab.templates || []).map(t => `<option value="${escapeHtml(t.id)}"${t.id === _lab.templateId ? ' selected' : ''}>${escapeHtml(t.name)} · ${escapeHtml(t.type)}</option>`).join('')}
                    </select>
                    <small class="uris-hint">Те же шаблоны, что во вкладке «Шаблоны». {{char}}/{{user}} и другие макросы ST разворачиваются по текущему чату.</small>
                </div>
                <div class="uris-field">
                    <label for="urisLabScene">Текст сцены (не обязан быть сообщением чата)</label>
                    <textarea class="text_pole" id="urisLabScene" rows="3">${escapeHtml(_lab.sceneText)}</textarea>
                </div>
                <label class="checkbox_label"><input type="checkbox" id="urisLabUseScene" ${_lab.useScene ? 'checked' : ''}><span>Резолвер сцены: сопоставить текст с референсами текущего чата</span></label>
                <div class="uris-settings-actions">
                    <button type="button" class="uris-btn uris-btn-outline" id="urisLabBuild"${_lab.building ? ' disabled' : ''}><i class="fa-solid fa-wand-magic-sparkles"></i> Построить промпт</button>
                </div>
                <div class="uris-field">
                    <label for="urisLabBuilt">Готовый промпт (можно править — уйдёт в генерацию ниже)</label>
                    <textarea class="text_pole" id="urisLabBuilt" rows="4">${escapeHtml(_lab.builtPrompt)}</textarea>
                    <small class="uris-hint" id="urisLabMatched">${escapeHtml(_lab.matchedLine)}</small>
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
                    <div id="urisLabRefs" style="max-height:160px;overflow:auto;border:1px solid var(--SmartThemeBorderColor,#444);border-radius:6px;padding:4px">
                        ${(_lab.refs || []).map(ref => `
                            <label class="checkbox_label" style="margin:2px 0"><input type="checkbox" data-ref-id="${escapeHtml(ref.id)}" ${_lab.refIds.has(ref.id) ? 'checked' : ''}><span>${escapeHtml(ref.name)}</span></label>`).join('') || '<small class="uris-hint">Пул пуст.</small>'}
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
        </div>`;
    bindLab(root);
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

function bindLab(root) {
    root.querySelector('#urisLabRefresh')?.addEventListener('click', () => refreshLabData(root));
    root.querySelector('#urisLabTemplate')?.addEventListener('change', e => { _lab.templateId = e.target.value; });
    root.querySelector('#urisLabScene')?.addEventListener('input', e => { _lab.sceneText = e.target.value; });
    root.querySelector('#urisLabUseScene')?.addEventListener('change', e => { _lab.useScene = e.target.checked === true; });
    root.querySelector('#urisLabBuilt')?.addEventListener('input', e => { _lab.builtPrompt = e.target.value; });
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

    root.querySelector('#urisLabBuild')?.addEventListener('click', async () => {
        const bridge = getBridge();
        if (!bridge || _lab.building) return;
        const text = _lab.sceneText.trim();
        if (!text) { labOut(root, 'Введите текст сцены.'); return; }
        const ctl = new AbortController();
        _lab.ctl = ctl;
        _lab.building = true;
        const btn = root.querySelector('#urisLabBuild');
        if (btn) btn.disabled = true;
        labOut(root, 'Строю промпт (Stage 1 — текстовый запрос к LLM)…');
        try {
            const res = await bridge.buildPrompt(
                { text, templateId: _lab.templateId || undefined, useScene: _lab.useScene },
                { caller: _lab.caller.trim() || 'bridge-test', signal: ctl.signal },
            );
            _lab.builtPrompt = res.prompt;
            _lab.prompt = res.prompt;
            const ta = root.querySelector('#urisLabBuilt');
            if (ta) ta.value = res.prompt;
            const pt = root.querySelector('#urisLabPrompt');
            if (pt) pt.value = res.prompt;
            const matched = res.matchedReferences
                .map(r => `${r.name}${r.effective ? '' : ' (исключён)'}`)
                .join(', ');
            _lab.matchedLine = matched
                ? `Резолвер нашёл: ${matched}`
                : 'Резолвер не нашёл совпадений в тексте.';
            const mEl = root.querySelector('#urisLabMatched');
            if (mEl) mEl.textContent = _lab.matchedLine;
            labOut(root, `Промпт готов [${res.requestId}] — перенесён в поле генерации ниже.`);
        } catch (e) {
            labOut(root, `Ошибка${e?.code ? ` [${e.code}]` : ''}: ${e?.message || e}`);
        } finally {
            _lab.building = false;
            _lab.ctl = null;
            if (btn) btn.disabled = false;
        }
    });

    root.querySelector('#urisLabRun')?.addEventListener('click', async () => {
        const bridge = getBridge();
        if (!bridge || _lab.running) return;
        const prompt = (_lab.builtPrompt || _lab.prompt).trim();
        if (!prompt) { labOut(root, 'Промпт пуст — постройте его выше или введите вручную.'); return; }
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
            const img = `<img src="/${escapeHtml(res.imagePath || '')}" alt="" style="max-width:100%;max-height:240px;border-radius:8px;border:1px solid var(--SmartThemeBorderColor,#444)">`;
            _lab.resultHtml = img;
            if (preview) preview.innerHTML = img;
            labOut(root, `Готово [${res.requestId}]: ${res.width ?? '?'}×${res.height ?? '?'} · ${res.imagePath}`);
        } catch (e) {
            labOut(root, `Ошибка${e?.code ? ` [${e.code}]` : ''}: ${e?.message || e}`);
            error('bridge lab:', e);
        } finally {
            _lab.ctl = null;
            labSetRunning(root, false);
        }
    });

    // Async fills after render — never block the tab paint.
    refreshLabData(root).catch(e => {
        recordUrisError({ scope: 'Мост', message: e?.message || String(e) });
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
        const [status, templates, refs, connections] = await Promise.all([
            bridge.getStatus(),
            bridge.listTemplates().catch(() => null),
            bridge.listRefs().catch(() => null),
            bridge.listConnections().catch(() => null),
        ]);
        const conn = status.connection
            ? `${status.connection.label} (${status.connection.modelId || 'модель не выбрана'})`
            : 'нет';
        _lab.statusText = `ready=${status.ready}, accepting=${status.accepting}; соединение чата: ${conn}; в работе: ${status.active.length}.`;
        const el = root?.querySelector?.('#urisLabStatus');
        if (el) el.textContent = _lab.statusText;
        if (templates) {
            _lab.templates = templates;
            const sel = root?.querySelector?.('#urisLabTemplate');
            if (sel) {
                sel.innerHTML = '<option value="">без шаблона (базовый режим)</option>'
                    + templates.map(t => `<option value="${escapeHtml(t.id)}"${t.id === _lab.templateId ? ' selected' : ''}>${escapeHtml(t.name)} · ${escapeHtml(t.type)}</option>`).join('');
            }
        }
        if (refs) {
            _lab.refs = refs;
            const box = root?.querySelector?.('#urisLabRefs');
            if (box) {
                box.innerHTML = refs.map(ref => `
                    <label class="checkbox_label" style="margin:2px 0"><input type="checkbox" data-ref-id="${escapeHtml(ref.id)}" ${_lab.refIds.has(ref.id) ? 'checked' : ''}><span>${escapeHtml(ref.name)}</span></label>`).join('')
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
}
