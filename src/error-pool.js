// @ts-check
/**
 * Session error pool: one neutral, user-clearable list of everything that
 * went wrong, surfaced as an ERR badge in the panel header.
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
 * Record an error. Deduplicated: the same scope+message within 5 seconds
 * bumps a counter instead of spamming a new row.
 * @param {{scope?:string, message:string}} input
 * @returns {object} the recorded entry
 */
export function recordUrisError({ scope = 'URIS', message } = {}) {
    const text = safeErrorText(message) || '(без сообщения)';
    const now = Date.now();
    const previous = _errors[_errors.length - 1];
    if (previous && previous.scope === scope && previous.message === text && (now - previous.firstAt) < 5000) {
        previous.count += 1;
        previous.ts = now;
        emitChanged();
        return previous;
    }
    const entry = { scope: String(scope), message: text, ts: now, firstAt: now, count: 1 };
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
    return `${time} · ${entry.scope}${count}: ${entry.message}`;
}
