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
 *
 * Каждая строка помнит свой лейн (lane): 'queue' — пачечная очередь,
 * 'manual' — ручная отправка/галерейный реген, 'auto' — авто-конвейер и
 * инлайн, 'external' — мостовые вызовы. По лейну панель бейджа решает,
 * показывать ли «Остановить очередь» (hasLiveQueueLane).
 */

const MAX_ROWS = 50;

/** @type {Array<{id:string, label:string, lane:string, status:'waiting'|'running'|'done', tone:'ok'|'fail'|null, detail:string, ts:number}>} */
let _rows = [];

function emit() {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try { window.dispatchEvent(new CustomEvent('uris:queue', { detail: { count: queueBadgeCount() } })); } catch { /* ignore */ }
    }
}

/**
 * Поставить генерацию в журнал. Повторный вызов с тем же id не плодит строку.
 * @param {{id:string, label:string, lane?:'queue'|'manual'|'auto'|'external'}} input
 */
export function noteQueued({ id, label, lane = 'manual' }) {
    if (!id || _rows.some(row => row.id === id)) return;
    _rows.push({ id: String(id), label: String(label || 'Генерация'), lane, status: 'waiting', tone: null, detail: '', ts: Date.now() });
    evictOldest();
    emit();
}

/**
 * Вытеснение при переполнении: сначала завершённые строки, живые — только
 * когда завершённых не осталось. Иначе бейдж недосчитывает живое, а
 * noteFinished вытесненных живых становится no-op.
 */
function evictOldest() {
    if (_rows.length <= MAX_ROWS) return;
    const doneIndex = _rows.findIndex(row => row.status === 'done');
    _rows.splice(doneIndex === -1 ? 0 : doneIndex, 1);
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

/** Живёт ли хоть одна задача пачечной очереди (панель бейджа показывает по этому «Остановить очередь»). */
export function hasLiveQueueLane() {
    return _rows.some(row => row.lane === 'queue' && row.status !== 'done');
}

/**
 * Лейн синтезируемой строки по source события uris:stage2-start.
 * Строки пачечной очереди заводит сам pipeline-queue (lane 'queue'), поэтому
 * source 'queue' сюда не попадает — окно его пропускает.
 * @param {string|undefined} source
 * @returns {'manual'|'auto'|'external'}
 */
export function laneFromSource(source) {
    if (source === 'auto') return 'auto';
    if (typeof source === 'string' && source.startsWith('external:')) return 'external';
    return 'manual';
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
