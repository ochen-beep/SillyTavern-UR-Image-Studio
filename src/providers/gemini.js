// @ts-check
/**
 * Gemini text provider.
 */
import { normalizeEndpoint, readResponseBody, error } from '../core.js';
import { autoFetch } from '../proxy.js';

/**
 * Native Gemini endpoints use an API key header; proxy and Vertex endpoints
 * use bearer authentication.
 */
function authHeaders(endpoint, apiKey) {
    const ep = String(endpoint || '').toLowerCase();
    const headers = {
        'Accept': 'application/json',
        'Accept-Encoding': 'identity',
        'Content-Type': 'application/json',
    };
    if (/generativelanguage\.googleapis\.com/.test(ep)) {
        headers['x-goog-api-key'] = apiKey;
    } else {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
}

/**
 * @param {import('./base.js').TextProfile} p
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {(s: string) => void} [onStatus]
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
export async function generateText(p, systemPrompt, userPrompt, onStatus, signal) {
    const url = `${normalizeEndpoint(p.endpoint)}/v1beta/models/${p.model}:generateContent`;
    if (!p.model) throw new Error('Gemini: модель не указана');

    const body = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
            temperature: p.temperature ?? 1.0,
            responseMimeType: 'application/json',
        },
    };

    const resp = await autoFetch(url, {
        method: 'POST',
        headers: authHeaders(p.endpoint, p.apiKey),
        body: JSON.stringify(body),
        signal,
    }, p.timeoutMs ?? 300000).catch(e => {
        // User cancellation must stay an AbortError (see openai.generateText).
        if (e?.name === 'AbortError') throw e;
        error('gemini.generateText: сетевая ошибка', url, e.message);
        if (/Timeout \(/.test(e?.message || '')) throw e;
        throw new Error(`Gemini Text API недоступен: ${e.message}`);
    });

    if (!resp.ok) {
        const e = await resp.text().catch(() => '');
        throw new Error(`Gemini Text HTTP ${resp.status}: ${e.slice(0, 300)}`);
    }

    const { text } = await readResponseBody(resp);
    let j = null;
    try { j = JSON.parse(text || ''); } catch { /* not JSON */ }
    if (!j) {
        if (text) throw new Error(`Gemini Text: неожиданный ответ (не JSON): ${text.slice(0, 300)}`);
        throw new Error('Gemini Text: пустой или не-JSON ответ');
    }
    const parts = j?.candidates?.[0]?.content?.parts || [];
    const texts = parts.filter(part => typeof part?.text === 'string' && !part.thought).map(part => part.text);
    if (texts.length) return texts.join('');
    throw new Error('Gemini: не удалось извлечь текст из ответа');
}
