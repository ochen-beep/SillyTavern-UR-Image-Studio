// @ts-check
/**
 * Общие асинхронные примитивы поллинга (пункт 2.4 плана 2026-10-05):
 * раньше sleep(ms, signal) + abortError() дублировались в image-comfyui.js и
 * image-naistera.js с точностью до текста ошибки.
 */

/** Типизированная отмена с сообщением конкретного контракта. */
export function abortError(message = 'Operation was cancelled.') {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

// Модуль намеренно standalone (без core.js). Таймеры сна не должны держать
// процесс Node живым в тестах; в браузере setTimeout — число, guard не нужен.
const unref = t => { if (t && typeof t === 'object' && typeof t.unref === 'function') t.unref(); return t; };

/**
 * Пауза, прерываемая сигналом: abort → reject(abortError(message)).
 * @param {number} ms
 * @param {AbortSignal|undefined} signal
 * @param {{abortMessage?: string}} [options]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal, { abortMessage = 'Operation was cancelled.' } = {}) {
    if (signal?.aborted) return Promise.reject(abortError(abortMessage));
    return new Promise((resolve, reject) => {
        const timer = unref(setTimeout(() => {
            signal?.removeEventListener?.('abort', onAbort);
            resolve();
        }, ms));
        function onAbort() {
            clearTimeout(timer);
            reject(abortError(abortMessage));
        }
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}
