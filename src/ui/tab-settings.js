// @ts-check
/**
 * Settings tab: UI scale, global behavior toggles (moved here from the ST
 * settings panel) and data/diagnostics actions shared with that panel.
 */
import {
    state, saveSettings, applyUiScale, applyFontScale, showConfirmModal, error, DISPLAY_NAME, escapeHtml, UNSTABLE_BADGE,
    UI_SCALE_MIN, UI_SCALE_MAX, UI_SCALE_STEP, UI_SCALE_DEFAULT, normalizeUiScale,
    FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_SCALE_STEP, FONT_SCALE_DEFAULT, normalizeFontScale,
    NOTIFY_SOUNDS, normalizeNotifyVolume, debounce,
} from '../core.js';
import { playStageSound } from '../notify.js';
import { runExport, runImportInteractive } from '../data-port.js';
import { deleteOrphanFiles, findOrphanRefFiles } from '../data-care.js';
import { exportDiagnosticDump, clearAllDiagnostics } from '../diagnostic-dump.js';
import { exportNetDump } from '../netdump.js';
import { reportFailure, URIS_SCOPES } from '../error-pool.js';
import { reconcileCards } from '../gallery-index.js';
import { clearGallery } from '../storage.js';
import { isStudioActive, resolveActiveChatId } from '../studio-scope.js';
import { refreshActive, renderTabs } from './tabs.js';
import { applyInlineRuntime } from './tab-media.js';

const percent = (scale) => String(Math.round(scale * 100));

/**
 * Whether the engine supports standardized CSS zoom — the carrier of --uris-scale.
 * Firefox Android <126 and ancient WebViews don't: the zoom rule in style.css is
 * ignored there, so the slider would spin idle — it is rendered disabled instead.
 * Environments without CSS.supports (test fakes, exotic embedders) count as
 * supported: no reason to punish an unknown environment preemptively.
 */
function zoomSupported() {
    try {
        if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return true;
        return CSS.supports('zoom', '1.5') === true;
    } catch {
        return true;
    }
}

/** @param {HTMLElement} root */
export function render(root) {
    if (!state.settings) {
        root.innerHTML = '<div class="uris-settings"><small class="uris-hint">Настройки ещё не загружены.</small></div>';
        return;
    }
    const scale = normalizeUiScale(state.settings.uiScale);
    const fontScale = normalizeFontScale(state.settings.fontScale);
    const zoomOk = zoomSupported();
    root.innerHTML = `
        <div class="uris-settings">
            <section class="uris-settings-section">
                <h3>Интерфейс</h3>
                <div class="uris-field">
                    <label for="urisUiScale">Масштаб интерфейса</label>
                    <div class="uris-row uris-scale-row">
                        <input type="range" id="urisUiScale" min="${percent(UI_SCALE_MIN)}" max="${percent(UI_SCALE_MAX)}" step="${percent(UI_SCALE_STEP)}" value="${percent(scale)}"${zoomOk ? '' : ' disabled'}>
                        <span class="uris-scale-value" id="urisUiScaleValue">${percent(scale)}%</span>
                        <button type="button" class="uris-btn uris-btn-ghost" id="urisUiScaleReset" title="Вернуть ${percent(UI_SCALE_DEFAULT)}%"${zoomOk ? '' : ' disabled'}>Сброс</button>
                    </div>
                    ${zoomOk
                        ? ''
                        : '<small class="uris-hint">Браузер не поддерживает масштабирование интерфейса (CSS zoom) — используйте «Размер шрифта»: он действует на любых устройствах.</small>'}
                </div>
                <div class="uris-field">
                    <label for="urisFontScale">Размер шрифта</label>
                    <div class="uris-row uris-scale-row">
                        <input type="range" id="urisFontScale" min="${percent(FONT_SCALE_MIN)}" max="${percent(FONT_SCALE_MAX)}" step="${percent(FONT_SCALE_STEP)}" value="${percent(fontScale)}">
                        <span class="uris-scale-value" id="urisFontScaleValue">${percent(fontScale)}%</span>
                        <button type="button" class="uris-btn uris-btn-ghost" id="urisFontScaleReset" title="Вернуть ${percent(FONT_SCALE_DEFAULT)}%">Сброс</button>
                    </div>
                </div>
            </section>
            <section class="uris-settings-section">
                <h3>Поведение</h3>
                <div class="uris-field">
                    <label for="uris_launcher_mode_tab">Кнопка запуска</label>
                    <select class="text_pole" id="uris_launcher_mode_tab" title="Какая кнопка открывает окно расширения">
                        <option value="bar" ${(state.settings.launcherMode || 'bar') === 'bar' ? 'selected' : ''}>quick-reply бар</option>
                        <option value="floating" ${(state.settings.launcherMode || 'bar') === 'floating' ? 'selected' : ''}>плавающая (FAB)</option>
                        <option value="both" ${(state.settings.launcherMode || 'bar') === 'both' ? 'selected' : ''}>обе</option>
                    </select>
                    <small class="uris-hint">Плавающая кнопка работает даже при выключенном Quick Replies; её можно перетаскивать — позиция запоминается.</small>
                </div>
                <label class="checkbox_label"><input type="checkbox" id="uris_debug_mode" ${state.settings.debugMode === true ? 'checked' : ''}><span>Debug-режим</span></label>
                <small class="uris-hint">Подробный технический trace для диагностики. Секреты и бинарные изображения не записываются.</small>
                <label class="checkbox_label"><input type="checkbox" id="uris_use_all_params" ${state.settings.useParametersForAllChats === true ? 'checked' : ''}><span>Использовать параметры генерации для всех чатов</span></label>
                <small class="uris-hint">Глобальные значения (стороны/размер/quality/модель) действуют, только если в текущем чате свой не задан. Изменение параметра во вкладке «Генерация» пишет глобальный дефолт, пока у чата нет собственного значения; как только задали — значение становится чат-локальным.</small>
                <label class="checkbox_label"><input type="checkbox" id="uris_inline_enabled" ${state.settings.inlineEnabled ? 'checked' : ''}><span>Инлайн-генерация в чате (вкладка «Медиа») ${UNSTABLE_BADGE}</span></label>
                <small class="uris-hint">[[тип: описание]] в ответах персонажа и 📷-кнопка превращаются в картинки. Профили триггеров — вкладка «Медиа».</small>
                <label class="checkbox_label"><input type="checkbox" id="uris_inline_chips" ${state.settings.inlineChips === true ? 'checked' : ''}><span>Компакт-режим инлайна (чипы вместо картинок) ${UNSTABLE_BADGE}</span></label>
                <small class="uris-hint">На месте маркера — чип «📷 тип»; клик раскрывает картинку, ⌃ сворачивает обратно. Удобно, когда картинок в посте много.</small>
                <label class="checkbox_label"><input type="checkbox" id="uris_auto_retry_ambiguous" ${state.settings.autoRetryAmbiguous === true ? 'checked' : ''}><span>Авто-повтор при неоднозначной доставке (очередь)</span></label>
                <small class="uris-hint">Если прямой запрос к шлюзу ушёл «без ответа», задача один раз переотправится сама — следующая попытка пойдёт через прокси. Выключено по умолчанию: повтор возможной уже оплаченной генерации — на вашей совести.</small>
            </section>
            <section class="uris-settings-section">
                <h3>Внешний мост <small class="uris-hint">(эксперимент)</small></h3>
                <label class="checkbox_label"><input type="checkbox" id="uris_bridge_enabled" ${state.settings.bridgeEnabled !== false ? 'checked' : ''}><span>Разрешить генерацию другим расширениям</span></label>
                <small class="uris-hint">Публикует globalThis.URIS: сторонние расширения (телефон, визуальная новелла) вызывают генерацию одним вызовом. Каждый вызов помечается caller'ом — видно в диагностике и галерее.</small>
                <label class="checkbox_label"><input type="checkbox" id="uris_bridge_tab" ${state.settings.bridgeTab === true ? 'checked' : ''}><span>Показывать вкладку «Мост»</span></label>
                <small class="uris-hint">Лаборатория моста: ручные вызовы (caller, референсы из пула, резолвер сцены), шаблоны Stage 1 над произвольным текстом и статус. Вкладка появится/исчезнет сразу после переключения.</small>
            </section>
            <section class="uris-settings-section">
                <h3>Уведомления</h3>
                <div class="uris-notify-row">
                    <label class="checkbox_label"><input type="checkbox" id="uris_notify_stage1" ${state.settings.notifyStage1 === true ? 'checked' : ''}><span>Промпт построен (Шаг 1)</span></label>
                    <select class="text_pole uris-notify-select" id="uris_notify_stage1_sound" title="Звук Шага 1">${soundOptions(state.settings.notifyStage1Sound)}</select>
                    <button type="button" class="uris-expand-btn" id="uris_notify_stage1_test" title="Прослушать" aria-label="Прослушать звук Шага 1"><i class="fa-solid fa-play"></i></button>
                </div>
                <div class="uris-notify-row">
                    <label class="checkbox_label"><input type="checkbox" id="uris_notify_stage2" ${state.settings.notifyStage2 !== false ? 'checked' : ''}><span>Картинка готова (Шаг 2)</span></label>
                    <select class="text_pole uris-notify-select" id="uris_notify_stage2_sound" title="Звук Шага 2">${soundOptions(state.settings.notifyStage2Sound)}</select>
                    <button type="button" class="uris-expand-btn" id="uris_notify_stage2_test" title="Прослушать" aria-label="Прослушать звук Шага 2"><i class="fa-solid fa-play"></i></button>
                </div>
                <div class="uris-field">
                    <label for="urisNotifyVolume">Громкость</label>
                    <div class="uris-row uris-scale-row">
                        <input type="range" id="urisNotifyVolume" min="0" max="100" step="5" value="${normalizeNotifyVolume(state.settings.notifyVolume)}">
                        <span class="uris-scale-value" id="urisNotifyVolumeValue">${normalizeNotifyVolume(state.settings.notifyVolume)}%</span>
                    </div>
                </div>
                <label class="checkbox_label"><input type="checkbox" id="uris_notify_unfocused" ${state.settings.notifyOnlyUnfocused !== false ? 'checked' : ''}><span>Только когда вкладка не в фокусе</span></label>
                <small class="uris-hint">Пока вкладка на виду, звук завершения не играется; кнопка ▶ проигрывает выбранный звук принудительно. Отменённые и ошибочные генерации молчат.</small>
            </section>
            <section class="uris-settings-section">
                <h3>Данные и диагностика</h3>
                <div class="uris-settings-actions">
                    <button type="button" class="uris-btn uris-btn-outline" id="urisTabExportData"><i class="fa-solid fa-file-export"></i> Экспорт данных</button>
                    <button type="button" class="uris-btn uris-btn-outline" id="urisTabImportData"><i class="fa-solid fa-file-import"></i> Импорт данных</button>
                    <button type="button" class="uris-btn uris-btn-outline" id="urisTabExportDiag"><i class="fa-solid fa-stethoscope"></i> Диагностика</button>
                    <button type="button" class="uris-btn uris-btn-outline" id="urisTabExportNet"><i class="fa-solid fa-network-wired"></i> Сетевой дамп</button>
                    <button type="button" class="uris-btn uris-btn-ghost" id="urisTabClearDiag"><i class="fa-solid fa-eraser"></i> Очистить</button>
                    <button type="button" class="uris-btn uris-btn-outline" id="urisTabGalleryRefresh" title="Пересканировать папки на сервере: подхватить внешние добавления и пометить внешние удаления"><i class="fa-solid fa-rotate"></i> Обновить галерею</button>
                    <button type="button" class="uris-btn uris-btn-outline" id="urisTabOrphanSweep" title="Найти файлы в URIS_Refs и URIS_Thumbs, на которые не ссылается ни одна карточка"><i class="fa-solid fa-broom"></i> Ничьи файлы</button>
                    <button type="button" class="uris-btn uris-btn-danger" id="urisTabGalleryClear"><i class="fa-solid fa-trash"></i> Очистить галерею</button>
                </div>
                <div id="urisOrphanSweepBox"></div>
                <small class="uris-hint">Диагностика содержит технические события и ошибки текущей сессии. Сетевой дамп выгружается отдельно и содержит только метаданные — без промптов и тел запросов/ответов; API-ключи и полные бинарные изображения не экспортируются. Рендер галереи сервер не сканирует — «Обновить галерею» запускает сверку с папками вручную; «Очистить галерею» удаляет генерации текущего чата.</small>
            </section>
        </div>`;
    bindScaleControls(root);
    bindNotifyControls(root);
    bindBehaviorToggles(root);
    bindBridgePanel(root);
    bindDataActions(root);
}

// ── Внешний мост: тумблеры. Ручные вызовы и лаборатория пайплайна живут
// на вкладке «Мост» (tab-bridge.js), она включается здесь же.
function bindBridgePanel(root) {
    root.querySelector('#uris_bridge_enabled')?.addEventListener('change', e => {
        state.settings.bridgeEnabled = e.target.checked === true;
        saveSettings();
    });
    root.querySelector('#uris_bridge_tab')?.addEventListener('change', e => {
        state.settings.bridgeTab = e.target.checked === true;
        saveSettings();
        // Перерисовать полосу вкладок — «Мост» появляется/исчезает сразу.
        renderTabs();
    });
}

/** Options list for the per-stage sound selects, from the shared catalog. */
function soundOptions(selected) {
    return Object.entries(NOTIFY_SOUNDS)
        .map(([id, def]) => `<option value="${escapeHtml(id)}"${id === selected ? ' selected' : ''}>${escapeHtml(def.label)}</option>`)
        .join('');
}

function bindNotifyControls(root) {
    for (const stage of ['stage1', 'stage2']) {
        root.querySelector(`#uris_notify_${stage}`)?.addEventListener('change', e => {
            state.settings[`notify${stage === 'stage1' ? 'Stage1' : 'Stage2'}`] = e.target.checked === true;
            saveSettings();
        });
        root.querySelector(`#uris_notify_${stage}_sound`)?.addEventListener('change', e => {
            state.settings[`notify${stage === 'stage1' ? 'Stage1' : 'Stage2'}Sound`] = e.target.value;
            saveSettings();
        });
        root.querySelector(`#uris_notify_${stage}_test`)?.addEventListener('click', () => {
            playStageSound(stage, { force: true });
        });
    }
    const volume = root.querySelector('#urisNotifyVolume');
    const volumeLabel = root.querySelector('#urisNotifyVolumeValue');
    // Sliders fire `input` on every drag step; the visual state applies live,
    // but the ST settings write is debounced (each save POSTs settings.json whole).
    const debouncedVolumeSave = debounce(saveSettings, 400);
    volume?.addEventListener('input', () => {
        const next = normalizeNotifyVolume(Number(volume.value));
        state.settings.notifyVolume = next;
        if (volumeLabel) volumeLabel.textContent = `${next}%`;
        debouncedVolumeSave();
    });
    root.querySelector('#uris_notify_unfocused')?.addEventListener('change', e => {
        state.settings.notifyOnlyUnfocused = e.target.checked === true;
        saveSettings();
    });
}

const SCALE_CONTROLS = [
    {
        slider: 'urisUiScale', value: 'urisUiScaleValue', reset: 'urisUiScaleReset',
        key: 'uiScale', normalize: normalizeUiScale, apply: applyUiScale, default: UI_SCALE_DEFAULT,
    },
    {
        slider: 'urisFontScale', value: 'urisFontScaleValue', reset: 'urisFontScaleReset',
        key: 'fontScale', normalize: normalizeFontScale, apply: applyFontScale, default: FONT_SCALE_DEFAULT,
    },
];

function bindScaleControls(root) {
    for (const cfg of SCALE_CONTROLS) {
        const slider = root.querySelector(`#${cfg.slider}`);
        const valueLabel = root.querySelector(`#${cfg.value}`);
        if (!slider || !valueLabel) continue;
        // Zoom/label apply live; the settings write is debounced — `input`
        // fires on every drag step and each save POSTs settings.json whole.
        const debouncedSave = debounce(saveSettings, 400);
        const applyFromSlider = () => {
            const next = cfg.normalize(Number(slider.value) / 100);
            state.settings[cfg.key] = next;
            valueLabel.textContent = `${percent(next)}%`;
            cfg.apply();
            debouncedSave();
        };
        slider.addEventListener('input', applyFromSlider);
        root.querySelector(`#${cfg.reset}`)?.addEventListener('click', () => {
            slider.value = percent(cfg.default);
            applyFromSlider();
        });
    }
}

function bindBehaviorToggles(root) {
    // Every tab re-renders on switch (setActiveTab), so unlike the ST panel
    // handler there is no need to refreshActive() the visible tab here.
    root.querySelector('#uris_launcher_mode_tab')?.addEventListener('change', e => {
        state.settings.launcherMode = e.target.value;
        saveSettings();
        // Перемонтирование лаунчеров (ensureLauncher) и синхронизацию селекта
        // в ST-панели делает index.js — событийный шов, как в tab-api
        // (uris:chat-generation-defaults-changed).
        window.dispatchEvent?.(new CustomEvent('uris:launcher-mode-changed'));
    });
    root.querySelector('#uris_debug_mode')?.addEventListener('change', e => {
        state.settings.debugMode = e.target.checked === true;
        saveSettings();
    });
    root.querySelector('#uris_auto_retry_ambiguous')?.addEventListener('change', e => {
        state.settings.autoRetryAmbiguous = e.target.checked === true;
        saveSettings();
    });
    root.querySelector('#uris_use_all_params')?.addEventListener('change', e => {
        state.settings.useParametersForAllChats = e.target.checked === true;
        saveSettings();
    });
    root.querySelector('#uris_inline_enabled')?.addEventListener('change', e => {
        state.settings.inlineEnabled = e.target.checked === true;
        saveSettings();
        // Сканер/DOM-рендер инлайна — общий хелпер вкладки «Медиа».
        applyInlineRuntime();
        // Вкладка «Медиа» появляется/исчезает из полосы сразу.
        renderTabs();
    });
    root.querySelector('#uris_inline_chips')?.addEventListener('change', e => {
        state.settings.inlineChips = e.target.checked === true;
        saveSettings();
        // Форма готовых/ожидающих оболочек входит в keep-гейт реконсиляции —
        // переключение перестраивает их на месте следующим проходом.
        try { window.dispatchEvent(new CustomEvent('uris:inline-update', {})); } catch { /* node */ }
    });
}

function bindDataActions(root) {
    root.querySelector('#urisTabExportData')?.addEventListener('click', () => { runExport(); });
    root.querySelector('#urisTabImportData')?.addEventListener('click', async () => {
        const result = await runImportInteractive();
        if (result) refreshActive();
    });
    root.querySelector('#urisTabExportDiag')?.addEventListener('click', () => {
        exportDiagnosticDump().catch(e => {
            error('exportDiagnosticDump:', e);
            reportFailure({ scope: URIS_SCOPES.diagnostics, message: e?.message || String(e), toast: true, toastText: 'Ошибка выгрузки диагностики: ' + (e?.message || e), toastTitle: DISPLAY_NAME });
        });
    });
    root.querySelector('#urisTabExportNet')?.addEventListener('click', () => {
        exportNetDump().catch(e => {
            error('exportNetDump:', e);
            reportFailure({ scope: URIS_SCOPES.netdump, message: e?.message || String(e), toast: true, toastText: 'Ошибка выгрузки сетевого дампа: ' + (e?.message || e), toastTitle: DISPLAY_NAME });
        });
    });
    // Галерея: reconcile только по явной кнопке (v0.9.4) — рендер вкладки
    // галереи сервер не сканирует. refreshActive перерисовывает настройки
    // с актуальным состоянием после действия.
    root.querySelector('#urisTabGalleryRefresh')?.addEventListener('click', async () => {
        try {
            await reconcileCards();
            toastr?.success('Галерея сверена с папками на сервере', DISPLAY_NAME);
        } catch (e) {
            error('reconcileCards:', e);
            reportFailure({ scope: URIS_SCOPES.gallery, message: e?.message || String(e), toast: true, toastText: 'Обновление галереи: ' + (e?.message || e), toastTitle: DISPLAY_NAME });
            return;
        }
        refreshActive();
    });
    root.querySelector('#urisTabGalleryClear')?.addEventListener('click', async () => {
        const studio = isStudioActive();
        if (!(await showConfirmModal(studio ? 'Очистить галерею студии?' : 'Очистить галерею этого чата?'))) return;
        try {
            await clearGallery(resolveActiveChatId());
            toastr?.success(studio ? 'Галерея студии очищена' : 'Галерея чата очищена', DISPLAY_NAME);
        } catch (e) {
            error('clearGallery:', e);
            reportFailure({ scope: URIS_SCOPES.gallery, message: e?.message || String(e), toast: true, toastText: 'Очистка галереи: ' + (e?.message || e), toastTitle: DISPLAY_NAME });
            return;
        }
        refreshActive();
    });
    root.querySelector('#urisTabClearDiag')?.addEventListener('click', async () => {
        const confirmed = await showConfirmModal('Очистить всю диагностику?\n\nБудут удалены события, логи, ошибки, сетевой дамп и локальные recovery-записи. Recovery может описывать уже оплаченный запрос с неизвестным результатом; действие не отменяет запрос у провайдера.');
        if (!confirmed) return;
        try {
            const { netCount, pendingCount } = await clearAllDiagnostics();
            toastr?.success(`Диагностика очищена: события, логи, ошибки, сетевой дамп (${netCount}) и recovery (${pendingCount})`, DISPLAY_NAME);
        } catch (e) {
            error('clearAllDiagnostics:', e);
            reportFailure({ scope: URIS_SCOPES.diagnostics, message: e?.message || String(e), toast: true, toastText: 'Не удалось полностью очистить диагностику: ' + (e?.message || e), toastTitle: DISPLAY_NAME });
        }
    });
    // Orphan sweep: report-only until the user confirms the deletion — the
    // referenced-set check must never guess wrong about a live record.
    root.querySelector('#urisTabOrphanSweep')?.addEventListener('click', async () => {
        const box = root.querySelector('#urisOrphanSweepBox');
        if (!box) return;
        box.innerHTML = '<small class="uris-hint">Сканирую папки…</small>';
        try {
            const orphans = await findOrphanRefFiles();
            if (!orphans.length) {
                box.innerHTML = '<small class="uris-hint">Ничьих файлов нет — папки референсов и миниатюр чистые.</small>';
                return;
            }
            box.innerHTML = orphans.map(p =>
                `<label class="checkbox_label"><input type="checkbox" checked data-orphan-path="${escapeHtml(p)}"><span class="uris-hint">${escapeHtml(p)}</span></label>`
            ).join('') + '<button type="button" class="uris-btn uris-btn-danger" id="urisOrphanDelete"><i class="fa-solid fa-trash"></i> Удалить отмеченные</button>';
            box.querySelector('#urisOrphanDelete')?.addEventListener('click', async () => {
                const paths = [...box.querySelectorAll('[data-orphan-path]')]
                    .filter(el => el.checked).map(el => el.getAttribute('data-orphan-path'));
                if (!paths.length) return;
                if (!(await showConfirmModal(`Удалить файлы (${paths.length})? Отменить это нельзя.`))) return;
                const deleted = await deleteOrphanFiles(paths);
                toastr?.success(`Удалено файлов: ${deleted}`, DISPLAY_NAME);
                refreshActive();
            });
        } catch (e) {
            box.innerHTML = '';
            error('orphan sweep:', e);
            reportFailure({ scope: URIS_SCOPES.storage, message: e?.message || String(e), toast: true, toastText: 'Свип ничьих файлов: ' + (e?.message || e), toastTitle: DISPLAY_NAME });
        }
    });
}
