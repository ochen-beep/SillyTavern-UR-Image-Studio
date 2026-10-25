// @ts-check
/**
 * Stage 1: call text-LLM to build the image prompt.
 * v2: thin dispatcher — chooses the invocation path:
 *   - 'profile' → Connection Manager ST (routed through ST server — no CORS/405)
 *   - 'custom'  → provider (openai-like | gemini) via src/providers/*
 *
 * v1 apiSource/profileId/customEndpoint/customModel live in state.settings
 * and are read here. v2: profile path remains, custom path delegates to providers.
 */
import { state, log, error, resolveApiType, getApiKey, callWithRetry } from './core.js';
import { generateWithProfile } from './text-connection.js';
import * as openai from './providers/openai.js';
import * as gemini from './providers/gemini.js';

/**
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {(s: string) => void} [onStatus]
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
/**
 * @param {string} systemPrompt
 * @param {string} userPrompt основной user-блок (Scene-сообщение из template-runtime)
 * @param {(s: string) => void} [onStatus]
 * @param {AbortSignal} [signal]
 * @param {string|null} [requestId]
 * @param {string[]} [extraUserMessages] дополнительные user-блоки контекста
 *   Stage 1 (persona/character/lore/history из stage1-context.js): профильный
 *   путь отправляет их отдельными {role:'user'} сообщениями, кастомный —
 *   склеивает '\n\n' в один user.
 * @returns {Promise<string>}
 */
export async function generatePromptText(systemPrompt, userPrompt, onStatus, signal = null, requestId = null, extraUserMessages = []) {
    const s = state.settings;
    const source = s.apiSource;
    log('generatePromptText: source =', source);

    if (source !== 'profile' && source !== 'custom') {
        throw new Error('Источник text-LLM не выбран. Выберите «Профиль» или «Свой» в настройках.');
    }
    const extras = (Array.isArray(extraUserMessages) ? extraUserMessages : []).filter(m => typeof m === 'string' && m.trim());

    return callWithRetry(async (attempt) => {
        onStatus?.(`Промпт${attempt ? ` (повтор ${attempt})` : ''}...`);

        if (source === 'profile') {
            return await generateWithProfile(s.profileId, systemPrompt, [userPrompt, ...extras], signal, requestId);
        }

        // source === 'custom' — delegate to provider
        const endpoint = s.customEndpoint;
        const model = s.customModel;
        if (!endpoint) throw new Error('URL эндпоинта пуст — укажите в настройках');

        const apiKey = await getApiKey();
        if (!apiKey) throw new Error('API ключ не задан — введите в настройках (Источник = «Свой»).');

        const joinedUser = [userPrompt, ...extras].join('\n\n');

        // Auto-detect provider by URL
        const apiType = resolveApiType(endpoint, model);
        const profile = {
            provider: apiType === 'gemini' ? 'gemini' : 'openai-like',
            endpoint,
            apiKey,
            model: model || '',
        };

        if (apiType === 'gemini') {
            return await gemini.generateText(profile, systemPrompt, joinedUser, onStatus, signal);
        }
        return await openai.generateText(profile, systemPrompt, joinedUser, onStatus, signal);
    }, 'text-api', 'network', signal);
}
