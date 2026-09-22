// @ts-check
/** OpenAI-compatible text chat completion provider. */
import {
    normalizeEndpointUrl,
    extractTextFromResponse,
    readResponseBody,
    error,
} from '../core.js';
import { autoFetch, probeDeliveryStrategy } from '../proxy.js';

/**
 * Generate a non-streaming text chat completion.
 *
 * @param {import('./base.js').TextProfile} p
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {(s: string) => void} [onStatus]
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
export async function generateText(p, systemPrompt, userPrompt, onStatus, signal) {
    const url = normalizeEndpointUrl(p.endpoint);
    if (!url) throw new Error('URL endpoint is empty');

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${p.apiKey}`,
    };
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });
    const body = { messages, stream: false };
    if (p.model) body.model = p.model;
    if (p.temperature != null) body.temperature = p.temperature;

    onStatus?.('Generating prompt...');
    // Дешёвая разведка до платного POST (probeDeliveryStrategy): один GET /models
    // с теми же заголовками определяет, принимает ли хост браузер напрямую, и
    // кэширует путь доставки — чтобы первый платный запрос сразу пошёл верной
    // дорогой. Best-effort: неудача разведки (кроме отмены) не блокирует
    // генерацию — autoFetch справится и без неё.
    await probeDeliveryStrategy(url, url.replace(/\/chat\/completions$/, '/models'), {
        headers, timeoutMs: 15000, signal,
    }).catch(e => {
        if (e?.name === 'AbortError') throw e;
        error('openai.generateText: delivery probe skipped', e.message);
    });
    const resp = await autoFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
    }, p.timeoutMs ?? 300000).catch(e => {
        // User cancellation must stay an AbortError: wrapping it would let
        // callWithRetry's retryable regex match "unavailable" and re-send the
        // cancelled request, and the pipeline would log it as an error.
        if (e?.name === 'AbortError') throw e;
        // DELIVERY_AMBIGUOUS (autoFetch): the request may have reached the
        // provider — rethrow as-is so it is neither rebranded nor retried.
        if (e?.noRetry) throw e;
        error('openai.generateText: network error', url, e.message);
        if (/Timeout \(/.test(e?.message || '')) throw e;
        throw new Error(`Text API is unavailable: ${e.message}`);
    });

    if (!resp.ok) {
        const responseText = await resp.text().catch(() => '');
        throw new Error(`Text API HTTP ${resp.status}: ${responseText.slice(0, 300)}`);
    }

    const { text } = await readResponseBody(resp);
    let data = null;
    try { data = JSON.parse(text || ''); } catch { /* not JSON */ }
    const extracted = extractTextFromResponse(data);
    if (extracted !== null) return extracted;
    throw new Error(`Text API returned an empty or unsupported response: ${(text || '').slice(0, 300)}`);
}
