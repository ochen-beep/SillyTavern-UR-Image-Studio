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
 * @param {{scope?:string, message:string, context?:{post?:number|string, connection?:string, model?:string}|null, quiet?:boolean}} input
 *   context: generation provenance shown in the panel row; quiet: entry lands
 *   in the dropdown but does not light the header badge.
 * @returns {object} the recorded entry
 */
export function recordUrisError({ scope = 'URIS', message, context = null, quiet = false } = {}) {
    const text = safeErrorText(message) || '(без сообщения)';
    const cleanContext = context ? {
        ...(context.post !== undefined && context.post !== null && context.post !== '' ? { post: context.post } : {}),
        ...(context.connection ? { connection: safeErrorText(context.connection).slice(0, 200) } : {}),
        ...(context.model ? { model: safeErrorText(context.model).slice(0, 200) } : {}),
    } : null;
    const hasContext = cleanContext && Object.keys(cleanContext).length > 0;
    const now = Date.now();
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
    _errors.push(entry);
    if (_errors.length > MAX_ERRORS) _errors.shift();
    emitChanged();
    return entry;
}

/** Current pool (newest last). */
export function listUrisErrors() {
    return _errors.slice();
}

/** Drop everything. */
export function clearUrisErrors() {
    _errors = [];
    emitChanged();
}

/** Format one entry for the panel row. */
export function formatUrisError(entry) {
    const time = new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const count = entry.count > 1 ? ` ×${entry.count}` : '';
    const context = entry.context || {};
    const parts = [
        context.post !== undefined && context.post !== null && context.post !== '' ? `пост #${context.post}` : '',
        context.connection ? `«${context.connection}»` : '',
        context.model || '',
    ].filter(Boolean);
    return `${time} · ${entry.scope}${count}: ${entry.message}` + (parts.length ? ` — ${parts.join(' · ')}` : '');
}
