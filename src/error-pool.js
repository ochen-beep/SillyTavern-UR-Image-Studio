// @ts-check
/**
 * Session event pool: one neutral, user-clearable list of everything that
 * went wrong, surfaced as an INFO badge in the panel header.
 *
 * Design constraints (per user feedback):
 *   - no red inline blocks scattered across tabs — errors collect here;
 *   - toastr toasts stay transient, the pool is the durable record;
 *   - DOM-free module: window event dispatch is guarded so node tests work.
 */
const MAX_ERRORS = 50;
let _errors = [];
// Badge "seen" baseline: entries recorded after this moment are unread.
// Panel open marks the pool seen; a dedupe bump refreshes `ts`, so a repeat
// of an old error lights the badge again on purpose (it *is* news).
let _lastSeenAt = 0;

// Строго монотонные таймстампы: запись и markUrisErrorsSeen случаются в одну
// миллисекунду (тест-машины, быстрые бампы), и голый Date.now() не различил бы
// «новое» от «просмотренного». Добор +1ms внутри одной ms безвреден: показ в
// панели — с точностью до секунды, дедуп-окно — минуты.
let _lastTs = 0;
function nowTs() {
    const t = Date.now();
    _lastTs = t > _lastTs ? t : _lastTs + 1;
    return _lastTs;
}

function safeErrorText(value) {
    const text = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
    return text.replace(/(Bearer\s+)[^\s,;]+/ig, '$1<redacted>')
        .replace(/([?&](?:key|token|secret|password|api[-_]?key)=)[^&\s]+/ig, '$1<redacted>')
        .slice(0, 1000);
}

function emitChanged() {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try { window.dispatchEvent(new CustomEvent('uris:errors', { detail: { count: _errors.length } })); } catch { /* ignore */ }
    }
}

/**
 * Record an error. Deduplicated: the same scope+message+post within 10 minutes
 * bumps a counter instead of spamming a new row (wide window on purpose —
 * quiet provider warnings repeat on every generation, minutes apart).
 * @param {{scope?:string, message:string, context?:{post?:number|string, connection?:string, model?:string}|null, quiet?:boolean, level?:'warn'|'error'}} input
 *   context: generation provenance shown in the panel row; quiet: entry lands
 *   in the dropdown but does not light the header badge; level: severity —
 *   'warn' rows render muted in the panel and never count as hard errors.
 * @returns {object} the recorded entry
 */
export function recordUrisError({ scope = 'URIS', message, context = null, quiet = false, level = 'error' } = {}) {
    const text = safeErrorText(message) || '(без сообщения)';
    const cleanContext = context ? {
        ...(context.post !== undefined && context.post !== null && context.post !== '' ? { post: context.post } : {}),
        ...(context.connection ? { connection: safeErrorText(context.connection).slice(0, 200) } : {}),
        ...(context.model ? { model: safeErrorText(context.model).slice(0, 200) } : {}),
    } : null;
    const hasContext = cleanContext && Object.keys(cleanContext).length > 0;
    const now = nowTs();
    const previous = _errors[_errors.length - 1];
    if (previous && previous.scope === scope && previous.message === text && previous.context?.post === cleanContext?.post
        && (now - previous.firstAt) < 600000) {
        previous.count += 1;
        previous.ts = now;
        emitChanged();
        return previous;
    }
    const entry = { scope: String(scope), message: text, ts: now, firstAt: now, count: 1 };
    if (hasContext) entry.context = cleanContext;
    if (quiet === true) entry.quiet = true;
    if (level === 'warn') entry.level = 'warn';
    _errors.push(entry);
    if (_errors.length > MAX_ERRORS) _errors.shift();
    emitChanged();
    return entry;
}

/** Current pool (newest last). */
export function listUrisErrors() {
    return _errors.slice();
}

/** Mark everything currently in the pool as seen (panel opened). */
export function markUrisErrorsSeen() {
    _lastSeenAt = nowTs();
}

/** Non-quiet entries recorded after the last markUrisErrorsSeen(). */
export function countUnreadUrisErrors() {
    return _errors.filter(entry => entry.quiet !== true && entry.ts > _lastSeenAt).length;
}

/** True when an unread non-quiet entry is a hard error (not a 'warn' row). */
export function hasUnreadHardUrisErrors() {
    return _errors.some(entry => entry.quiet !== true && entry.level !== 'warn' && entry.ts > _lastSeenAt);
}

/** Drop everything (also resets the seen baseline — nothing left to be unread). */
export function clearUrisErrors() {
    _errors = [];
    _lastSeenAt = 0;
    emitChanged();
}

/** Format one entry for the panel row. */
export function formatUrisError(entry) {
    const time = new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const count = entry.count > 1 ? ` ×${entry.count}` : '';
    const context = entry.context || {};
    const parts = [
        // 1-based, как в QUEUE-бейдже: один и тот же пост не должен
        // нумероваться по-разному в двух панелях.
        context.post !== undefined && context.post !== null && context.post !== '' ? `пост #${Number(context.post) + 1}` : '',
        context.connection ? `«${context.connection}»` : '',
        context.model || '',
    ].filter(Boolean);
    return `${time} · ${entry.scope}${count}: ${entry.message}` + (parts.length ? ` — ${parts.join(' · ')}` : '');
}

/**
 * Канонический реестр скоупов пула. recordUrisError по-прежнему принимает
 * любую строку (дампы/тесты), но вызовы берут значение отсюда: свободные
 * строки расползлись до 17 вариантов с синонимами, «Диагностика» писалась
 * из четырёх файлов по памяти.
 */
export const URIS_SCOPES = Object.freeze({
    auto: 'Автогенерация',
    generation: 'Генерация',
    provider: 'Провайдер',
    params: 'Параметры',
    stage1: 'Stage 1',
    probe: 'Проверка',
    refs: 'Референсы',
    gallery: 'Галерея',
    copy: 'Копирование',
    templates: 'Шаблоны',
    bridge: 'Мост',
    api: 'API',
    dataPort: 'Импорт/экспорт',
    diagnostics: 'Диагностика',
    netdump: 'Сетевой дамп',
    recovery: 'Recovery',
    ui: 'UI',
});

/**
 * Одна точка «тост + запись в пул». 26 из 35 мест вызова дублировали текст
 * ошибки в toastr рядом с recordUrisError; хелпер держит пару синхронной.
 * Тексты тостов переносятся дословно (toastText), заголовок — toastTitle.
 * DOM-free: toastr читается с globalThis с guarded-вызовом (как в file-store),
 * поэтому node-тесты импортируют модуль без оговорок.
 */
export function reportFailure({
    scope = 'URIS', message, context = null, level = 'error', quiet = false,
    toast = false, toastText = null, toastKind = 'error', toastTitle = null,
} = {}) {
    const entry = recordUrisError({ scope, message, context, level, quiet });
    if (toast) {
        try { globalThis.toastr?.[toastKind]?.(toastText ?? entry.message, toastTitle || undefined); } catch { /* no toastr in tests */ }
    }
    return entry;
}
