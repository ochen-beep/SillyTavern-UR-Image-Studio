// @ts-check
/**
 * URIS logging: console mirror + bounded ring buffers feeding the diagnostic
 * dump (an export meant to leave the machine), so secrets are scrubbed once
 * here — at the buffer boundary — instead of at every logging site.
 *
 * Leaf module: depends only on error-pool's redactSecrets. The debug gate
 * (trace/dumpDebugLog) is inverted — core.js wires it to settings.debugMode
 * at load via bindDebugGate, so this module never imports core (no cycle);
 * unbound gate = debug output disabled.
 */
import { redactSecrets } from './error-pool.js';

const logBuffer = [];
const debugBuffer = [];
const MAX_LOG = 300;
const MAX_DEBUG_LOG = 300;
const MAX_LOG_ARG_CHARS = 2000;
const SECRET_KEY_RE = /(?:api[-_]?key|authorization|token|password|secret|credential)/i;

let debugGate = null;

/**
 * Wire the debug-mode check (called once from core.js at load). The gate is
 * re-evaluated on every trace/dump call, so settings changes apply live.
 * @param {() => boolean} fn
 */
export function bindDebugGate(fn) { debugGate = fn; }

function serializeLogArg(value) {
    if (value instanceof Error) {
        const stack = typeof value.stack === 'string' ? value.stack.slice(0, MAX_LOG_ARG_CHARS) : '';
        return `${value.name || 'Error'}: ${value.message || ''}${stack ? `\n${stack}` : ''}`;
    }
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value.length > MAX_LOG_ARG_CHARS
        ? `${value.slice(0, MAX_LOG_ARG_CHARS)} …(truncated)`
        : value;
    if (typeof value !== 'object') return String(value);
    try {
        const seen = new WeakSet();
        const json = JSON.stringify(value, (key, item) => {
            if (SECRET_KEY_RE.test(key)) return '<redacted>';
            if (item && typeof item === 'object') {
                if (seen.has(item)) return '[Circular]';
                seen.add(item);
            }
            return item;
        });
        return json.length > MAX_LOG_ARG_CHARS
            ? `${json.slice(0, MAX_LOG_ARG_CHARS)} …(truncated)`
            : json;
    } catch {
        try { return String(value); } catch { return '[Unserializable]'; }
    }
}

function serializeLogArgs(args) {
    return args.map(value => serializeLogArg(value)).join(' ');
}

function push(buffer, level, args, limit) {
    const ts = new Date().toISOString();
    // The buffer feeds the diagnostic dump — an export meant to leave the
    // machine — so secrets are scrubbed once here (connection URLs carrying
    // `?key=…`, Bearer headers, userinfo) instead of at every logging site.
    buffer.push(`[${ts}] [${level}] ${redactSecrets(serializeLogArgs(args))}`);
    if (buffer.length > limit) buffer.shift();
}

export function log(...a)   { push(logBuffer, 'INFO', a, MAX_LOG); console.log('[URIS]', ...a); }
export function warn(...a)  { push(logBuffer, 'WARN', a, MAX_LOG); console.warn('[URIS]', ...a); }
export function error(...a) { push(logBuffer, 'ERROR', a, MAX_LOG); console.error('[URIS]', ...a); }

/** Verbose success-path diagnostics. Never writes to console; gated by debugMode. */
export function trace(...a) {
    if (!debugGate?.()) return;
    push(debugBuffer, 'DEBUG', a, MAX_DEBUG_LOG);
}

export function dumpLog() {
    return logBuffer.length ? logBuffer.join('\n') : '(лог URIS пуст)';
}

/**
 * WARN/ERROR slice of the log for the diagnostic dump. INFO lines duplicate
 * the structured eventLog (stage transitions, capability observations), so
 * shipping the full log meant paying for every success-path line twice.
 */
export function dumpProblemLog() {
    const problems = logBuffer.filter(line => line.includes(' [WARN] ') || line.includes(' [ERROR] '));
    return problems.length ? problems.join('\n') : '';
}

export function dumpDebugLog() {
    if (!debugGate?.()) return '(дебаг-лог пуст: Debug-режим выключен)';
    return debugBuffer.length ? debugBuffer.join('\n') : '(дебаг-лог пуст)';
}

/** Clear both console-mirror and verbose diagnostic buffers. */
export function clearDiagnosticLogs() {
    logBuffer.length = 0;
    debugBuffer.length = 0;
}

/** Backward-compatible alias used by the settings UI and older callers. */
export function clearDebugLog() { clearDiagnosticLogs(); }
