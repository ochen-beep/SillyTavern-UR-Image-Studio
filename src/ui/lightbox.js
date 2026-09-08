// @ts-check
/**
 * Lightbox: PhotoSwipe-based fullscreen viewer.
 *
 * Gestures (pinch zoom, double-tap, pan, swipe navigation, vertical-drag-to-
 * close, wheel zoom, keyboard) are PhotoSwipe's; this module maps gallery
 * items to the dataSource and wires the four gallery actions as custom
 * toolbar buttons. All actions stay in gallery-actions.js — single source of
 * truth shared with the grid.
 *
 * Behavior parity with the previous hand-rolled viewer:
 * - copy prompt / save as reference keep the viewer open (ST dialogs are
 *   native <dialog> in the top layer, so they render above PhotoSwipe);
 * - regenerate / delete close it when the action completes, so the re-rendered
 *   grid shows the new state;
 * - focus returns to the trigger (PhotoSwipe `returnFocus`).
 *
 * Do NOT add lockBodyScroll here: PhotoSwipe runs its own scroll lock, and
 * two independent locks release in the wrong order, leaving <body> frozen.
 */
import PhotoSwipe from '../vendor/photoswipe.esm.js';
import { copyItemText, cropGalleryImage, cropReference, saveAsReference, regenerate, deleteImage } from './gallery-actions.js';
import { getCtx } from '../core.js';
import { cardDimensions, ensureCardDimensions, FALLBACK_DIMENSIONS } from '../image-dimensions.js';

let _active = null;  // open PhotoSwipe instance; a new open closes the previous one

/**
 * Open the fullscreen viewer for a single image (reference editor preview,
 * generation preview chips). No thumbnail element — the viewer fades in.
 * Everything besides src/width/height (name, aliases, description, prompt…)
 * lands on the item and feeds the copy-text menu. `actions: 'ref'` switches
 * the toolbar to reference actions (copy/crop) instead of the gallery set.
 */
export function showSingleImage({ src, width, height, actions, refId, ...text }) {
    if (!src) return;
    const item = { src, width, height, ...text };
    if (actions) item.__actions = actions;
    if (refId) item.__refId = refId;
    return showLightbox([item], 0, {});
}

/**
 * Open the fullscreen viewer for gallery items.
 *
 * @param {Array<{id:string, src:string, prompt?:string, style?:string, width?:number, height?:number}>} items
 * @param {number} [index]
 * @param {{chatId?: string|null, root?: HTMLElement|null}} [options]
 */
export async function showLightbox(items, index = 0, { chatId = null, root = null } = {}) {
    if (!items?.length) return;
    _active?.close();
    const chatIdResolved = chatId ?? getCtx().chatId ?? null;
    const start = Math.max(0, Math.min(items.length - 1, index));

    // PhotoSwipe requires dimensions up front (layout + open animation).
    // The requested slide is probed synchronously (persisted on the card, so
    // this cost is paid once per image); the rest get the fallback box and are
    // probed in the background below.
    const thumbs = collectThumbElements(root, items);
    const dataSource = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const dims = cardDimensions(item)
            || (i === start ? await ensureCardDimensions(chatIdResolved, item) : FALLBACK_DIMENSIONS);
        dataSource.push({
            src: item.src,
            // Placeholder for the open animation: the small variant when the
            // grid has one, otherwise the full image (browser-cached anyway).
            msrc: item.thumbPath || item.src,
            width: dims.width,
            height: dims.height,
            alt: item.prompt || 'Изображение из галереи',
            // Grid thumbnails are square-cropped (aspect-ratio:1 + cover);
            // thumbCropped makes the open animation clip instead of squashing.
            thumbCropped: true,
            ...(thumbs[i] ? { element: thumbs[i] } : {}),
        });
    }

    const pswp = new PhotoSwipe({
        dataSource,
        index: start,
        bgOpacity: 0.9,
        wheelToZoom: true,
        errorMsg: 'Не удалось загрузить изображение',
        mainClass: 'uris-pswp',
    });
    _active = pswp;
    pswp.on('destroy', () => { if (_active === pswp) _active = null; });

    registerActionButtons(pswp, { items, chatId: chatIdResolved, root });
    pswp.init();
    localizeDefaultUi(pswp);

    // Fill in real dimensions for the remaining slides; entries update before
    // the user typically reaches them, and probes persist on the cards.
    for (let i = 0; i < items.length; i++) {
        if (i === start) continue;
        ensureCardDimensions(chatIdResolved, items[i])
            .then(dims => { dataSource[i].width = dims.width; dataSource[i].height = dims.height; })
            .catch(() => { /* fallback box already in place */ });
    }
}

/** QuerySelector the grid thumbnail (the card image button) for every item. */
function collectThumbElements(root, items) {
    if (!root?.querySelectorAll) return [];
    return items.map(item => {
        if (!item?.id) return null;
        return root.querySelector(`.uris-card[data-id="${CSS.escape(String(item.id))}"] .uris-card-img`) || null;
    });
}

/**
 * Wire the toolbar buttons. Two modes: gallery items get the full set
 * (copy / crop → new card / save-as-ref / regen / delete); reference items
 * (actions: 'ref', from References and Generation) get copy + crop — regen and
 * delete make no sense for a reference and the record lives in the editor.
 */
function registerActionButtons(pswp, ctx) {
    const refMode = ctx.items.some(item => item.__actions === 'ref');
    const buttons = refMode ? [
        { name: 'uris-copy', order: 30, icon: 'fa-copy', title: 'Копировать текст', danger: false, run: item => copyItemText(item) },
        { name: 'uris-crop', order: 31, icon: 'fa-crop-simple', title: 'Обрезать референс', danger: false, run: async item => { if (await cropReference(item)) pswp.close(); } },
    ] : [
        { name: 'uris-copy', order: 30, icon: 'fa-copy', title: 'Копировать текст', danger: false, run: item => copyItemText(item) },
        { name: 'uris-crop', order: 31, icon: 'fa-crop-simple', title: 'Обрезать (в новую карточку)', danger: false, run: async item => { if (await cropGalleryImage(item, ctx.chatId, ctx.root)) pswp.close(); } },
        { name: 'uris-save-ref', order: 32, icon: 'fa-bookmark', title: 'Сохранить как референс', danger: false, run: item => saveAsReference(item) },
        { name: 'uris-regen', order: 33, icon: 'fa-rotate-right', title: 'Перегенерировать', danger: false, run: async item => { await regenerate(item, ctx.root, null); pswp.close(); } },
        { name: 'uris-del', order: 34, icon: 'fa-trash', title: 'Удалить', danger: true, run: async item => { await deleteImage(item, ctx.chatId, ctx.root); pswp.close(); } },
    ];
    pswp.on('uiRegister', () => {
        for (const button of buttons) {
            pswp.ui.registerElement({
                name: button.name,
                order: button.order,
                isButton: true,
                tagName: 'button',
                className: 'uris-pswp-act' + (button.danger ? ' uris-pswp-act-danger' : ''),
                title: button.title,
                ariaLabel: button.title,
                html: `<i class="fa-solid ${button.icon}" aria-hidden="true"></i>`,
                appendTo: 'bar',
                onClick: () => {
                    const item = ctx.items[pswp.currIndex];
                    if (item) void button.run(item);
                },
            });
        }
    });
}

/** Stock UI titles are English; ST users get Russian. */
function localizeDefaultUi(pswp) {
    const titles = [
        ['.pswp__button--close', 'Закрыть (Esc)'],
        ['.pswp__button--arrow--prev', 'Предыдущее (←)'],
        ['.pswp__button--arrow--next', 'Следующее (→)'],
        ['.pswp__button--zoom', 'Во весь экран'],
    ];
    for (const [selector, title] of titles) {
        const el = pswp.element?.querySelector(selector);
        if (el) {
            el.title = title;
            el.setAttribute('aria-label', title);
        }
    }
}
