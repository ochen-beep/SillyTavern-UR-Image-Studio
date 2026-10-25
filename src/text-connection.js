// @ts-check
/**
 * UR Image Studio — Text-LLM source: port of the pattern from DS Comments (src/connection.js).
 *
 * Two paths for calling text-LLM for image prompt building:
 *   1. "Profile" — ST Connection Manager. The request is routed by the ST SERVER
 *      (via ConnectionManagerRequestService), so CORS/405 do not apply.
 *      Requires the connection-manager extension to be enabled.
 *   2. "Custom"  — direct browser fetch() to an OpenAI-compatible endpoint.
 *      The endpoint MUST return CORS headers (Access-Control-Allow-Origin +
 *      Access-Control-Allow-Headers: Authorization, Content-Type), otherwise the browser
 *      blocks. LM Studio / OpenRouter / most self-hosted gateways provide CORS.
 *      If the provider does not — use the "Profile" source.
 *
 * API key for "Custom" is stored in localforage (LF_API_KEY), NOT in settings JSON
 * (spec §10 as in DS Comments).
 *
 * This is independent of URIS image connections. Image connections live
 * separately in src/connections.js and do not touch this module.
 */
import { getCtx, extractTextFromResponse, log, warn, withDeadline } from './core.js';
import { recordFromProfile, recordFromProfileError } from './netdump.js';
import { getDiagnosticSessionId, hashDiagnosticId } from './diagnostic-events.js';

let _cmReady = false;
let _cmReadyChecked = false;

// ── Connection Manager profiles ──

function _getCMProfiles() {
    try {
        const ctx = getCtx();
        if (ctx?.extensionSettings?.connectionManager?.profiles?.length > 0) {
            return ctx.extensionSettings.connectionManager.profiles;
        }
    } catch {}
    try {
        // Fallback: ST's own connection-manager reads global extension_settings.
        const globalES = window?.extension_settings || globalThis?.extension_settings;
        if (globalES?.connectionManager?.profiles?.length > 0) {
            return globalES.connectionManager.profiles;
        }
    } catch {}
    return [];
}

async function waitForConnectionManager(maxAttempts = 15, delayMs = 300) {
    if (_cmReady) return true;
    if (!_cmReadyChecked) {
        try {
            if (_getCMProfiles().length > 0) {
                _cmReady = true;
                _cmReadyChecked = true;
                return true;
            }
        } catch {}
        _cmReadyChecked = true;
    }
    for (let i = 0; i < maxAttempts; i++) {
        try {
            if (_getCMProfiles().length > 0) {
                _cmReady = true;
                return true;
            }
        } catch {}
        await new Promise(r => setTimeout(r, delayMs));
    }
    warn('connectionManager не ответил за отведённое время');
    return false;
}

export async function getProfiles() {
    const available = await waitForConnectionManager();
    if (!available) return [];
    try {
        const profiles = _getCMProfiles();
        // Profile without id and without name has no descriptor — Connection Manager
        // cannot route a request to it. Skip, not fabricating random ids.
        return profiles
            .filter(p => p.id || p.name)
            .map(p => ({
                id:   p.id || p.name,
                name: p.name || p.id || 'Unknown Profile',
            }));
    } catch (e) { warn('getProfiles error:', e); return []; }
}

export async function getProfileDetails(profileId) {
    const available = await waitForConnectionManager();
    if (!available) return null;
    try {
        const profiles = _getCMProfiles();
        return profiles.find(p => p.id === profileId || p.name === profileId) || null;
    } catch (e) { warn('getProfileDetails error:', e); return null; }
}

// ── Profile source: generate ──

// Профильный путь идёт через ST-сервер (ConnectionManagerRequestService) мимо
// fetchWithTimeout — единственный платный вызов без собственного дедлайна.
// 5 минут — дефолт провайдеров custom-пути (providers/*.js: p.timeoutMs ?? 300000).
const STAGE1_PROFILE_TIMEOUT_MS = 300000;

/**
 * Сообщения профильного запроса. userPrompt — строка ИЛИ массив user-блоков
 * (контекст Stage 1 из stage1-context.js): каждый блок — отдельное
 * {role:'user'} сообщение, CM передаёт массив as-is (как у DS-Comments —
 * request log показывает, где persona/карточка/лорбук/история).
 * Экспортировано для тестов формы запроса.
 */
export function buildProfileMessages(systemPrompt, userPrompt) {
    const userBlocks = (Array.isArray(userPrompt) ? userPrompt : [userPrompt])
        .map(block => String(block ?? ''))
        .filter(block => block.trim());
    return [
        { role: 'system', content: systemPrompt },
        ...userBlocks.map(content => ({ role: 'user', content })),
    ];
}

export async function generateWithProfile(profileIdOrName, systemPrompt, userPrompt, signal = null, requestId = null, opts = {}) {
    const ctx = getCtx();

    if (!profileIdOrName) {
        throw new Error('Не выбран профиль подключения. Выберите профиль в настройках UR Image Studio (Источник = «Профиль»).');
    }
    if (!ctx.ConnectionManagerRequestService?.sendRequest) {
        throw new Error('Connection Manager недоступен — включите расширение connection-manager или выберите источник «Свой».');
    }

    const cmReady = await waitForConnectionManager();
    if (!cmReady) {
        throw new Error('Connection Manager не ответил за отведённое время. Проверьте, что включено расширение connection-manager и выбран профиль.');
    }

    let profile = null;
    try {
        const all = _getCMProfiles();
        profile = all.find(p => p.id === profileIdOrName || p.name === profileIdOrName) || null;
    } catch (e) {
        throw new Error(`Не удалось прочитать профили Connection Manager: ${e?.message || e}`);
    }
    if (!profile) {
        throw new Error(`Профиль подключения не найден: «${profileIdOrName}». Возможно, он был удалён — выберите профиль заново в настройках UR Image Studio.`);
    }

    log(`generateWithProfile: профиль «${profile.name}»`);
    const messages = buildProfileMessages(systemPrompt, userPrompt);

    let response;
    try {
        const _t0 = performance.now();
        // Дедлайн обязателен: ST-сервер не ограничивает время sendRequest, без
        // обёртки зависший профильный запрос висел бы вечно. Внешняя отмена
        // (signal) проходит насквозь и сильнее дедлайна.
        response = await withDeadline(
            opts.timeoutMs ?? STAGE1_PROFILE_TIMEOUT_MS,
            signal || null,
            (deadlineSignal) => ctx.ConnectionManagerRequestService.sendRequest(
                profile.id, messages, undefined,
                { stream: false, signal: deadlineSignal, extractData: true, includePreset: false, includeInstruct: false },
            ),
        );
        // Network dumper: the profile path Stage1 goes through the ST server, bypassing
        // fetchWithTimeout — so we record it here. Non-blocking.
        recordFromProfile(profile, messages, response, performance.now() - _t0, {
            sessionId: getDiagnosticSessionId(),
            requestId,
            stage: 'stage1',
            chatHash: hashDiagnosticId(getCtx().chatId),
            modelId: profile?.model || null,
            role: 'stage1',
        }).catch(() => {});
    } catch (e) {
        recordFromProfileError(profile, messages, new Error(`Профиль «${profile?.name}»: ${e?.message || e}`), 0, {
            sessionId: getDiagnosticSessionId(),
            requestId,
            stage: 'stage1',
            chatHash: hashDiagnosticId(getCtx().chatId),
            modelId: profile?.model || null,
            role: 'stage1',
        }).catch(() => {});
        // ConnectionManagerRequestService wraps all errors as
        // new Error('API request failed', { cause }). AbortError comes as e.cause.
        if (signal?.aborted || e?.name === 'AbortError' || e?.cause?.name === 'AbortError') {
            throw new DOMException('Aborted', 'AbortError');
        }
        const cause = e?.cause;
        const detail = cause?.message ? cause.message : (e?.message || String(e));
        throw new Error(`Профиль «${profile.name}»: ${detail}`);
    }

    const text = extractTextFromResponse(response);
    if (text === null) {
        warn('generateWithProfile: не удалось извлечь текст из ответа', response);
        throw new Error(`Профиль «${profile.name}» ответил, но не удалось извлечь текст.`);
    }
    return text;
}

// Custom-endpoint generation is in src/providers/openai.js and src/providers/gemini.js
// (text-api.js delegates source='custom' to providers via resolveApiType).

