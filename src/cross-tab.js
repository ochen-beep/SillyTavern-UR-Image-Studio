// @ts-check
/**
 * Cross-tab watchdog (пункт 5 плана 2026-10-05): сторы — full-document writes
 * с in-process мьютексами, у них нет никакой координации МЕЖДУ вкладками
 * (last-writer-wins, удаление другой вкладкой может быть «воскрешено» полной
 * записью — file-store.js KNOWN LIMITATION). Web Locks API даёт честный
 * браузерный мьютекс: вторая вкладка узнаёт о первой и предупреждает юзера.
 *
 * Не блокирует работу: просмотр/генерация возможны в обеих вкладках, баннер
 * честно говорит о риске перетирания настроек.
 */

let releaseLock = null;

/**
 * Попытаться взять синглтон-лок расширения. 'acquired' — эта вкладка держит
 * замок; 'busy' — замок у другой вкладки; 'unsupported' — нет Web Locks
 * (Firefox < 96, приватные контексты, Node-тесты) — молча пропускаем.
 * @param {void} [_onBusy] зарезервировано: колбэк на занятый замок
 * @returns {Promise<'acquired'|'busy'|'unsupported'>}
 */
export async function acquireSingletonLock(_onBusy) {
    if (typeof navigator === 'undefined' || !navigator.locks?.request) return 'unsupported';
    return new Promise(resolve => {
        let settled = false;
        const settle = value => { if (!settled) { settled = true; resolve(value); } };
        navigator.locks.request('ur_image_studio:singleton', { ifAvailable: true }, lock => {
            if (!lock) { settle('busy'); return; }
            settle('acquired');
            // Держим замок до releaseSingleton() или выгрузки страницы
            // (браузер снимает замок сам при закрытии вкладки).
            return new Promise(release => { releaseLock = release; });
        }).catch(() => settle('unsupported'));
    });
}

/** Отпустить синглтон-замок (extension disable). Идемпотентно. */
export function releaseSingletonLock() {
    try { releaseLock?.(); } catch { /* already released */ }
    releaseLock = null;
}
