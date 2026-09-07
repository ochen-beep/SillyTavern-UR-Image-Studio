// @ts-check
/**
 * Persistent accordion/collapsible state.
 *
 * Stores per-section open/close flags in `state.settings.accordionState`
 * (object `sectionId -> boolean`, true = open). Default for a missing key
 * = open (`defaultOpen = true`), so new accordions don't surprise the user
 * with a collapsed state. Writes go through `saveSettings()` (debounced SillyTavern).
 *
 * Two UI patterns:
 *   - custom `.uris-acc-header` + `.uris-acc-body` with CSS class `hidden`
 *     → `bindHeaderToggle(header, body, id)`.
 *   - native `<details>` with `open` attribute → `bindDetailsToggle(details, id)`.
 *
 * All helpers are idempotent: re-render recreates the DOM, and the same
 * calling bind-* again will restore the initial state from storage and attach a fresh listener.
 */
import { state, saveSettings } from '../core.js';

/**
 * Read saved accordion state.
 * @param {string} id  Stable section identifier (see data-accordion-id).
 * @param {boolean} [defaultOpen=true]  What to return if the key is missing.
 * @returns {boolean} true = open.
 */
export function getAccordionOpen(id, defaultOpen = true) {
    const map = state.settings?.accordionState;
    if (!map || typeof map !== 'object') return defaultOpen;
    const v = map[id];
    if (v === true || v === false) return v;
    return defaultOpen;
}

/**
 * Write accordion state and persist to ST settings.
 * @param {string} id
 * @param {boolean} open
 */
export function setAccordionOpen(id, open) {
    if (!state.settings) return;
    if (typeof state.settings.accordionState !== 'object' || state.settings.accordionState === null) {
        state.settings.accordionState = {};
    }
    if (state.settings.accordionState[id] === open) return; // no-op without unnecessary write
    state.settings.accordionState[id] = open;
    saveSettings();
}

/**
 * Remove orphan key (e.g. when the owning entity is deleted).
 * @param {string} id
 */
export function forgetAccordion(id) {
    const map = state.settings?.accordionState;
    if (!map || typeof map !== 'object') return;
    if (!(id in map)) return;
    delete map[id];
    saveSettings();
}

/**
 * Bind native `<details>` to persistent state.
 * Sets initial `open` from storage, then `toggle` listener synchronises
 * changes to storage. Recursion guard: only writes if the new state
 * differs from the saved one (avoids write loop on programmatic open).
 *
 * @param {HTMLDetailsElement|null} detailsEl
 * @param {string} id
 * @param {boolean} [defaultOpen=true]
 */
export function bindDetailsToggle(detailsEl, id, defaultOpen = true) {
    if (!detailsEl) return;
    // Initial state from storage — set before the listener so the toggle
    // doesn't trigger a write.
    const initial = getAccordionOpen(id, defaultOpen);
    if (detailsEl.open !== initial) {
        detailsEl.open = initial;
    }
    detailsEl.addEventListener('toggle', () => {
        // The new details state is already in the DOM — write if different.
        setAccordionOpen(id, detailsEl.open);
    });
}

/**
 * Bind custom `.uris-acc-header` + `.uris-acc-body` pattern.
 * Initial `.hidden` class on body from storage, click on header toggles.
 *
 * @param {HTMLElement|null} headerEl
 * @param {HTMLElement|null} bodyEl
 * @param {string} id
 * @param {boolean} [defaultOpen=true]
 */
export function bindHeaderToggle(headerEl, bodyEl, id, defaultOpen = true) {
    if (!headerEl || !bodyEl) return;
    const initial = getAccordionOpen(id, defaultOpen);
    bodyEl.classList.toggle('hidden', !initial);
    headerEl.addEventListener('click', (e) => {
        // Click on interactive elements inside the header (input) should not
        // collapse the section — let it be handled by its own handler.
        if (e.target.closest('input,select,textarea,button')) return;
        const willClose = !bodyEl.classList.contains('hidden'); // currently open → click closes
        bodyEl.classList.toggle('hidden', willClose);
        setAccordionOpen(id, !willClose);
    });
}