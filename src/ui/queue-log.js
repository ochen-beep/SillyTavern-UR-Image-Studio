// @ts-check
/**
 * Журнал очереди генераций для бейджа QUEUE.
 *
 * Пакетная очередь (pipeline-queue.js) забывает элемент в момент старта, а
 * ручные и авто-генерации в неё не попадают вовсе. Здесь одна лента на все
 * пути: ждёт, выполняется, чем кончилось. Модуль без DOM — бейдж только
 * читает его и перерисовывается по событию `uris:queue`.
 *
 * Цифра бейджа считает живое: waiting + running. Завершённое остаётся в
 * ленте до очистки, чтобы было видно, что получилось.
 */

const MAX_ROWS = 50;

/** @type {Array<{id:string, label:string, status:'waiting'|'running'|'done', tone:'ok'|'fail'|null, detail:string, ts:number}>} */
let _rows = [];

function emit() {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try { window.dispatchEvent(new CustomEvent('uris:queue', { detail: { count: queueBadgeCount() } })); } catch { /* ignore */ }
    }
}

/**
 * Поставить генерацию в журнал. Повторный вызов с тем же id не плодит строку.
 * @param {{id:string, label:string}} input
 */
export function noteQueued({ id, label }) {
    if (!id || _rows.some(row => row.id === id)) return;
    _rows.push({ id: String(id), label: String(label || 'Генерация'), status: 'waiting', tone: null, detail: '', ts: Date.now() });
    if (_rows.length > MAX_ROWS) _rows.shift();
    emit();
}

/** Генерация началась: строка переходит из «ждёт» в «выполняется». */
export function noteRunning(id) {
    const row = _rows.find(item => item.id === id);
    if (!row || row.status === 'done') return;
    row.status = 'running';
    row.ts = Date.now();
    emit();
}

/**
 * Генерация кончилась.
 * @param {string} id
 * @param {'success'|'error'|'cancelled'} outcome
 * @param {string} [detail] короткая причина для строки ленты
 */
export function noteFinished(id, outcome, detail = '') {
    const row = _rows.find(item => item.id === id);
    if (!row) return;
    row.status = 'done';
    row.tone = outcome === 'success' ? 'ok' : outcome === 'error' ? 'fail' : null;
    row.detail = detail ? String(detail).slice(0, 300) : '';
    row.ts = Date.now();
    emit();
}

/** Лента сверху вниз в порядке постановки. */
export function listQueueLog() {
    return _rows.map(row => ({ ...row }));
}

/** Сколько генераций ещё живы: ждут или выполняются. */
export function queueBadgeCount() {
    return _rows.filter(row => row.status !== 'done').length;
}

/** Убрать завершённое. То, что ещё в работе, остаётся — его не стереть кнопкой. */
/**
 * Убрать завершённое. То, что ещё в работе, остаётся — его не стереть кнопкой.
 * `all: true` — полный сброс, только для тестов: между кейсами журнал должен
 * начинаться пустым, иначе строки предыдущего теста живут до конца процесса.
 */
export function clearQueueLog({ all = false } = {}) {
    _rows = all ? [] : _rows.filter(row => row.status !== 'done');
    emit();
}
