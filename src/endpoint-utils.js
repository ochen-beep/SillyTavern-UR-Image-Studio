// @ts-check
/**
 * Единая нормализация endpoint'ов по дескриптору контракта (пункт 2.3 плана
 * 2026-10-05). Раньше у каждого адаптера был свой нормализатор (endpointBase,
 * comfyBase, baseUrl naistera, generationUrl pollinations, base openrouter,
 * версия gemini), плюс собственные билдеры каталога — 10+ реализаций одного
 * правила «обрезать хвост, дописать версию». Теперь форма канонического base
 * живёт в descriptor.endpoint.normalize, пути — в descriptor.endpoint.*Path.
 *
 * Контракт на поведение: нормализация выдаёт байт-в-байт те же URL, что и
 * старые нормализаторы (существующие тесты адаптеров не меняют ожиданий).
 */

/** Тримминг + удаление хвостовых слэшей. */
export function stripTrailingSlashes(value) {
    return String(value ?? '').trim().replace(/\/+$/, '');
}

/** Удалить хвостовую версию (/v1) — pollinations так канонизирует base. */
export function stripVersionSuffix(value, pattern = /\/v1$/i) {
    return stripTrailingSlashes(value).replace(pattern, '');
}

/**
 * Дописать версию, если суффикс уже не стоит.
 * @param {string} value
 * @param {string} version '/v1' | '/v1beta'
 * @param {RegExp} [keepPattern] что считать «версия уже есть» (gemini: /v1 и /v1beta)
 */
export function withVersionSuffix(value, version, keepPattern = /\/v1$/i) {
    const base = stripTrailingSlashes(value);
    if (keepPattern.test(base)) return base;
    return `${base}${version}`;
}

/**
 * Канонический base endpoint'а по дескриптору. Бросает ошибку с кодом
 * INVALID_ENDPOINT и текстом дескриптора (error-формы старых нормализаторов
 * сохранены в endpoint.invalidMessage).
 * @param {{endpoint?: {normalize?: Function, invalidMessage?: string}}|null} descriptor
 * @param {string|undefined} rawEndpoint
 * @returns {string} канонический base без хвостовых слэшей
 */
export function resolveEndpoint(descriptor, rawEndpoint) {
    const normalize = descriptor?.endpoint?.normalize;
    if (typeof normalize !== 'function') {
        throw invalidEndpoint(descriptor, 'Image provider endpoint is required.');
    }
    const base = normalize(rawEndpoint);
    if (!base) throw invalidEndpoint(descriptor, 'Image provider endpoint is required.');
    return base;
}

/** ':name' → encodeURIComponent(params[name]). */
export function interpolatePath(path, params = {}) {
    return String(path || '').replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (match, name) => {
        const value = params[name];
        return value == null ? match : encodeURIComponent(String(value));
    });
}

function invalidEndpoint(descriptor, fallbackMessage) {
    const error = new Error(descriptor?.endpoint?.invalidMessage || fallbackMessage);
    error.code = 'INVALID_ENDPOINT';
    return error;
}
