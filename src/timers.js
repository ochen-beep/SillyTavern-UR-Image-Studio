// @ts-check
/**
 * Timer helpers. Leaf module — no imports; core.js re-exports it for the
 * existing consumers (file-store, sharded-file-store, http transport).
 */

/**
 * Не держать процесс Node живым ради таймера (тесты: без --test-force-exit).
 * В браузере setTimeout возвращает число — guard ничего не делает.
 * @param {ReturnType<typeof setTimeout>} timer
 * @returns {ReturnType<typeof setTimeout>} тот же timer (для цепочек)
 */
export function unrefTimer(timer) {
    if (timer && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
    return timer;
}
