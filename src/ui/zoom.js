// @ts-check
/**
 * Coordinate spaces under standardized CSS zoom (css-viewport-1, Chromium 128+).
 *
 * The UI-scale zoom (--uris-scale) applies to .uris-tabs/.uris-body — see the
 * comment block in style.css. Inside that subtree two measurement families
 * disagree: getBoundingClientRect() returns viewport-relative values INCLUDING
 * zoom, while the client/offset/scroll family returns element-relative values
 * EXCLUDING it. When code needs VISUAL pixels from the client/offset family,
 * convert via the effective zoom — never by dividing the --uris-scale state
 * value: currentCSSZoom also accounts for zoom an ST theme or another
 * extension may apply to the host page ancestors.
 */

/**
 * Effective CSS zoom of an element: the product of its own and all ancestors'
 * zoom factors. Returns 1 for null/undefined inputs and unrendered elements
 * (per spec, currentCSSZoom is 1 when no box is generated).
 * @param {Element|null|undefined} el
 * @returns {number}
 */
export function effectiveZoom(el) {
    if (!el) return 1;
    // Standard API (Baseline 2026). `in` — не getattr: у фейковых DOM-объектов
    // тестов свойство может отсутствовать, у реальных движков без поддержки — тоже.
    if ('currentCSSZoom' in el) {
        const z = /** @type {any} */ (el).currentCSSZoom;
        return typeof z === 'number' && Number.isFinite(z) && z > 0 ? z : 1;
    }
    // Older engines that already parse zoom but predate currentCSSZoom.
    try {
        if (typeof getComputedStyle === 'function') {
            const z = parseFloat(/** @type {any} */ (getComputedStyle(el)).zoom ?? '');
            if (Number.isFinite(z) && z > 0) return z;
        }
    } catch { /* detached node / exotic environment */ }
    return 1;
}

/**
 * clientWidth recalculated into visual (post-zoom) CSS pixels.
 * @param {Element|null|undefined} el
 * @returns {number}
 */
export function visualWidth(el) {
    if (!el) return 0;
    return el.clientWidth * effectiveZoom(el);
}
