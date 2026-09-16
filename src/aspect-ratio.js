// @ts-check
/**
 * Pure aspect-ratio arithmetic shared by the wire adapters and the dispatcher.
 *
 * Ratios travel as "W:H" strings everywhere (UI, bridge, gallery), but three
 * questions need real math:
 *   1. Did the returned pixels match what was requested? (Gemini's documented
 *      9:16 slot is 768x1344, which gcd-reduces to 4:7 — string equality of
 *      reduced fractions false-positives, so comparison is numeric with a
 *      tolerance.)
 *   2. Did the caller already state a ratio in the prompt text, making the
 *      settings choice a documented conflict?
 *   3. Which tokens in free text are plausible aspect statements at all
 *      (as opposed to clock times like 10:30 or scores like 3:2 in a game
 *      recap — "3:2" IS an aspect, a time generally is not)?
 */

import { VALID_ASPECT_RATIOS } from './core.js';

/** Matches "9:16", "16 : 9" etc. 1-3 digits per side keeps IP slices (192:168) plausible to filter downstream. */
const RATIO_TOKEN_RE = /\b(\d{1,3})\s*:\s*(\d{1,3})\b/g;

/** How far an exact pixel slot may sit from the requested ratio (Gemini 9:16 → 768x1344 deviates 1.6%). */
export const ASPECT_TOLERANCE = 0.04;

/**
 * @param {unknown} value
 * @returns {{w:number, h:number}|null} positive integers, or null when the
 *   string is not a "W:H" ratio.
 */
export function parseRatio(value) {
    if (typeof value !== 'string') return null;
    const m = value.trim().match(/^(\d{1,4})\s*:\s*(\d{1,4})$/);
    if (!m) return null;
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (!w || !h) return null;
    return { w, h };
}

/** "768x1344" → "4:7"-style reduced string, for compact log/journal display. */
export function reducedRatio(width, height) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return null;
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const d = gcd(width, height) || 1;
    return `${width / d}:${height / d}`;
}

/**
 * Relative deviation of actual pixels from the requested ratio, or null when
 * there is nothing comparable (no dimensions, no requested ratio) or the
 * deviation is within tolerance.
 * @param {number|null|undefined} width
 * @param {number|null|undefined} height
 * @param {string|undefined|null} requested "W:H"
 * @param {number} [tolerance] relative, default 4%
 * @returns {number|null} deviation as a fraction (0.218 → "218% off")
 */
export function aspectDeviates(width, height, requested, tolerance = ASPECT_TOLERANCE) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    const req = parseRatio(requested);
    if (!req) return null;
    const deviation = Math.abs(width / height - req.w / req.h) / (req.w / req.h);
    return deviation > tolerance ? deviation : null;
}

/**
 * Aspect statements in the prompt that CONTRADICT the requested ratio.
 * A token counts as an aspect statement only when its reduced fraction is a
 * ratio URIS offers (clock times like 10:30 reduce to 1:3 — not offered) or
 * it numerically matches the requested ratio within 2% (models return slots
 * like 768x1344 for 9:16). Everything else is left alone: warning about a
 * "9:16" camera-time mention must not happen, and neither must rewriting or
 * suppressing anything — the caller only gets a warning, the wire prompt is
 * never edited.
 * @param {string|undefined|null} prompt
 * @param {string|undefined|null} requested "W:H"
 * @returns {string[]} normalized contradicting tokens, e.g. ["16:9"]
 */
export function promptAspectConflicts(prompt, requested) {
    if (typeof prompt !== 'string' || !prompt) return [];
    const req = parseRatio(requested);
    if (!req) return [];
    const reqValue = req.w / req.h;
    const conflicts = new Set();
    for (const m of prompt.matchAll(RATIO_TOKEN_RE)) {
        const w = Number(m[1]);
        const h = Number(m[2]);
        if (!w || !h) continue;
        const value = w / h;
        const matchesRequest = Math.abs(value - reqValue) / reqValue <= 0.02;
        if (matchesRequest) continue;
        const known = VALID_ASPECT_RATIOS.includes(reducedRatio(w, h) || '') || VALID_ASPECT_RATIOS.includes(`${w}:${h}`);
        if (!known) continue;
        conflicts.add(`${w}:${h}`);
    }
    return [...conflicts];
}
