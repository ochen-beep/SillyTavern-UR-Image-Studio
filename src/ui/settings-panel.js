// @ts-check
/**
 * ST extensions settings panel: the inline-drawer under Extensions settings.
 * Extracted from index.js (hygiene split 2026-10-25) — this module owns the
 * markup and handlers; index-local lifecycle (init/cleanup/launcher/window)
 * arrives as hooks so there is no import cycle back into index.js.
 */
import { state, DISPLAY_NAME, saveSettings, showConfirmModal, error, log, warn } from '../core.js';
import { reportFailure, URIS_SCOPES } from '../error-pool.js';
import { refreshActive } from './tabs.js';

let _panelLoaded = false;

/**
 * Creates and injects the extension settings panel into the ST extensions settings container.
 * @param {{ onEnabledChange: (enabled: boolean) => void, onLauncherModeChange: () => void, onOpenWindow: () => void }} hooks
 * @returns {void}
 */
export function createSettingsPanel(hooks) {
    if (_panelLoaded) return;
    // Different ST versions use either extensions_settings or extensions_settings2.
    const container = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
    if (!container) { warn('createSettingsPanel: extension settings container not found'); return; }
    _panelLoaded = true;
    log('createSettingsPanel: rendering settings panel');
    const div = document.createElement('div');
    div.className = 'inline-drawer';
    div.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${DISPLAY_NAME}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input type="checkbox" id="uris_enabled" ${state.settings.enabled ? 'checked' : ''}><span>Включить</span></label>
            <div class="flex-row">
                <select id="uris_launcher_mode" class="uris-w-full" title="Какая кнопка открывает окно расширения">
                    <option value="bar" ${state.settings.launcherMode === 'bar' ? 'selected' : ''}>Кнопка: quick-reply бар</option>
                    <option value="floating" ${state.settings.launcherMode === 'floating' ? 'selected' : ''}>Кнопка: плавающая (FAB)</option>
                    <option value="both" ${state.settings.launcherMode === 'both' ? 'selected' : ''}>Кнопки: обе</option>
                </select>
            </div>
            <small class="uris_hint">Плавающая кнопка работает даже при выключенном расширении Quick Replies; её можно перетаскивать — позиция запоминается.</small>
            <small class="uris_hint">Debug-режим, масштаб интерфейса и остальные настройки — вкладка «Настройки» в окне расширения.</small>

            <hr>

            <div class="flex-row"><div id="uris_open_window" class="menu_button uris-w-full"><i class="fa-solid fa-window-restore"></i> Открыть окно</div></div>
            <div class="flex-row"><div id="uris_export_data" class="menu_button uris-w-full"><i class="fa-solid fa-file-export"></i> Экспорт данных (backup)</div></div>
            <div class="flex-row"><div id="uris_import_data" class="menu_button uris-w-full"><i class="fa-solid fa-file-import"></i> Импорт данных (backup)</div></div>
            <div class="flex-row"><div id="uris_export_diagnostic" class="menu_button uris-w-full"><i class="fa-solid fa-stethoscope"></i> Экспорт диагностики</div></div>
            <div class="flex-row"><div id="uris_export_network" class="menu_button uris-w-full"><i class="fa-solid fa-network-wired"></i> Экспорт сетевого дампа</div></div>
            <div class="flex-row"><div id="uris_clear_diagnostic" class="menu_button uris-w-full"><i class="fa-solid fa-eraser"></i> Очистить всю диагностику</div></div>
            <small class="uris_hint">Диагностика содержит технические события и ошибки текущей сессии. Сетевой дамп выгружается отдельно и содержит только метаданные (адреса, статусы, длительность, имена заголовков, размеры тел) — промпты и тела запросов/ответов не записываются. Очистка удаляет журналы и локальные recovery-записи.</small>
        </div>`;
    container.appendChild(div);
    bindSettingsPanel(div, hooks);
}

/**
 * Binds event listeners to the settings panel controls.
 * @param {HTMLElement} host - the settings panel element
 * @param {{ onEnabledChange: (enabled: boolean) => void, onLauncherModeChange: () => void, onOpenWindow: () => void }} hooks
 * @returns {void}
 */
function bindSettingsPanel(host, hooks) {
    host.querySelector('#uris_enabled').addEventListener('change', e => {
        state.settings.enabled = e.target.checked;
        saveSettings();
        hooks.onEnabledChange(e.target.checked);
    });
    host.querySelector('#uris_launcher_mode').addEventListener('change', e => {
        state.settings.launcherMode = e.target.value;
        saveSettings();
        hooks.onLauncherModeChange();
    });
    host.querySelector('#uris_open_window').addEventListener('click', () => {
        hooks.onOpenWindow();
    });
    host.querySelector('#uris_export_data').addEventListener('click', () => {
        void import('../data-port.js').then(m => m.runExport());
    });
    host.querySelector('#uris_import_data').addEventListener('click', async () => {
        const { runImportInteractive } = await import('../data-port.js');
        const result = await runImportInteractive();
        if (result) refreshActive();
    });
    host.querySelector('#uris_export_diagnostic').addEventListener('click', async () => {
        const { exportDiagnosticDump } = await import('../diagnostic-dump.js');
        exportDiagnosticDump().catch(e => {
            error('exportDiagnosticDump:', e);
            reportFailure({ scope: URIS_SCOPES.diagnostics, message: e?.message || String(e) });
        });
    });
    host.querySelector('#uris_export_network').addEventListener('click', async () => {
        const { exportNetDump } = await import('../netdump.js');
        exportNetDump().catch(e => {
            error('exportNetDump:', e);
            reportFailure({ scope: URIS_SCOPES.netdump, message: e?.message || String(e) });
        });
    });
    host.querySelector('#uris_clear_diagnostic').addEventListener('click', async () => {
        const confirmed = await showConfirmModal('Очистить всю диагностику?\n\nБудут удалены события, логи, ошибки, сетевой дамп и локальные recovery-записи. Recovery может описывать уже оплаченный запрос с неизвестным результатом; действие не отменяет запрос у провайдера.');
        if (!confirmed) return;
        try {
            const { clearAllDiagnostics } = await import('../diagnostic-dump.js');
            const { netCount, pendingCount } = await clearAllDiagnostics();
            toastr?.success(`Диагностика очищена: события, логи, ошибки, сетевой дамп (${netCount}) и recovery (${pendingCount})`, DISPLAY_NAME);
        } catch (e) {
            error('clearDiagnostic:', e);
            reportFailure({ scope: URIS_SCOPES.diagnostics, message: e?.message || String(e), toast: true, toastText: 'Не удалось полностью очистить диагностику: ' + (e?.message || e), toastTitle: DISPLAY_NAME });
        }
    });
    // NOTE: intentionally NOT attaching our own toggle on .inline-drawer-toggle — the ST core
    // manages .hidden on .inline-drawer-content through its own delegated handler.
    // Previously a second toggle was attached here: clicking would toggle .hidden twice
    // → the class never changed → the user could not expand the settings panel
    // (seeing an "empty field" even though the DOM contained the checkbox and buttons).
}
