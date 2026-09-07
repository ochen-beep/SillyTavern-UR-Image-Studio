// @ts-check
/**
 * Full-surface text editor for large prompt/template fields, following the
 * SillyTavern core "Expand text area" pattern: a `textarea.maximized_textarea`
 * shown inside a native <dialog> Popup (callGenericPopup). Keeping the
 * maximized_textarea class stays compatible with editor-replacement extensions
 * (e.g. CodeMirror) that watch for that class inside popup dialogs.
 *
 * Returns null when ST popups are unavailable or the user cancelled; callers
 * treat null as "keep the current value" (never clears a field).
 */
import { getCtx } from '../core.js';

// ctx.POPUP_RESULT.AFFIRMATIVE on current ST; older builds resolve 1/true.
const RESULT_AFFIRMATIVE = 1;

/**
 * Show the expanded editor for one text value.
 * @param {{
 *   value?: string,
 *   title?: string,
 *   rows?: number,
 *   placeholder?: string,
 *   okButton?: string,
 *   cancelButton?: string,
 * }} [opts]
 * @returns {Promise<string|null>} edited text on OK, null on cancel/no-ST
 */
export async function editTextModal(opts = {}) {
    const ctx = getCtx();
    if (!ctx?.callGenericPopup || ctx?.POPUP_TYPE?.TEXT == null) return null;
    const {
        value = '',
        title = '',
        rows = 18,
        placeholder = '',
        okButton = 'Сохранить',
        cancelButton = 'Отмена',
    } = opts;

    const wrap = document.createElement('div');
    wrap.classList.add('uris-text-editor');
    if (title) {
        const head = document.createElement('div');
        head.classList.add('uris-text-editor-title');
        head.textContent = title;
        wrap.appendChild(head);
    }
    const ta = document.createElement('textarea');
    ta.classList.add('text_pole');
    ta.classList.add('maximized_textarea');
    ta.rows = rows;
    ta.value = value ?? '';
    if (placeholder) ta.placeholder = placeholder;
    wrap.appendChild(ta);

    // rows>1 on the popup input applies the ST multiline-popup rule:
    // Enter inserts a linebreak instead of submitting the dialog.
    const result = await ctx.callGenericPopup(wrap, ctx.POPUP_TYPE.TEXT, '', {
        okButton,
        cancelButton,
        rows,
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        leftAlign: true,
    });
    const affirmed = result === RESULT_AFFIRMATIVE || result === true || result === ctx.POPUP_RESULT?.AFFIRMATIVE;
    return affirmed ? ta.value : null;
}
