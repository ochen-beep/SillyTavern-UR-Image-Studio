// @ts-check
/**
 * Lightbox: PhotoSwipe-based fullscreen viewer.
 *
 * Gestures (pinch zoom, double-tap, pan, swipe navigation, vertical-drag-to-
 * close, wheel zoom, keyboard) are PhotoSwipe's; this module maps gallery
 * items to the dataSource and wires the four gallery actions as custom
 * toolbar buttons. All actions stay in gallery-actions.js — single source of
 * truth shared with the grid. ПКМ/long-press по картинке открывает
 * контекстное меню (правка промпта, «ещё») — тот же жест, что у карточек
 * сетки (card-action-menu.js).
 *
 * Behavior parity with the previous hand-rolled viewer:
 * - copy prompt / save as reference keep the viewer open (ST dialogs are
 *   native <dialog> in the top layer, so they render above PhotoSwipe);
 * - regenerate / delete close it only when the action succeeded — a cancelled
 *   dialog or a failed/aborted run keeps the viewer open, so the toast about
 *   what happened is not read over an already-vanished grid;
 * - focus returns to the trigger (PhotoSwipe `returnFocus`).
 *
 * Do NOT add lockBodyScroll here: PhotoSwipe runs its own scroll lock, and
 * two independent locks release in the wrong order, leaving <body> frozen.
 */
// PhotoSwipe (~200 КБ) грузится ЛЕНИВО — динамическим импортом при первом
// открытии просмотра. Статический импорт парсил вендора на каждый старт ST,
// даже если лайтбокс не открывался ни разу (Croppr/fzstd и так ленивые —
// непоследовательно). Система модулей кэширует динамический импорт: две
// гонки открытий получат один и тот же конструктор.
let _photoSwipeCtor = null;
async function loadPhotoSwipe() {
    if (!_photoSwipeCtor) {
        ({ default: _photoSwipeCtor } = await import('../vendor/photoswipe.esm.js'));
    }
    return _photoSwipeCtor;
}
import { copyItemText, copyImageToClipboard, cropGalleryImage, cropReference, saveAsReference, regenerate, editPromptAndRegenerate, deleteImage, toggleFavorite, assignGalleryFolders, downloadImage } from './gallery-actions.js';
import { bindCardContextMenu, openCardActionMenu } from './card-action-menu.js';
import { getCtx } from '../core.js';
import { cardDimensions, ensureCardDimensions, FALLBACK_DIMENSIONS } from '../image-dimensions.js';

let _active = null;  // open PhotoSwipe instance; a new open closes the previous one
// Monotonic open sequence: a superseded open must not materialize its viewer
// after the one that superseded it. Without this, two quick opens (double-click
// on two cards) both pass the `_active?.close()` line before either has created
// its instance, both await the dimension probe, and the SLOWER call then mounts
// its viewer on top of the faster one's live viewer — a zombie viewer the UI
// believes was closed (observed as a doubled backdrop and dead controls).
let _openSeq = 0;

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
    const seq = ++_openSeq;
    _active?.close();
    // Первым await'ом — ленивый импорт вендора: гонка открытий защищена
    // seq-гардом ниже, а его позиция (после await'ов, до new PhotoSwipe)
    // от добавления этого await не меняется.
    const PhotoSwipe = await loadPhotoSwipe();
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

    // A newer showLightbox superseded this one while it probed dimensions:
    // mount nothing — the newer call owns `_active` now.
    if (seq !== _openSeq) return;

    const pswp = new PhotoSwipe({
        dataSource,
        index: start,
        bgOpacity: 0.9,
        wheelToZoom: true,
        errorMsg: 'Не удалось загрузить изображение',
        mainClass: 'uris-pswp',
        // Меньше вендорных дефолтов (333 мс на всё): при drag/pinch-закрытии
        // пользователь уже завершил движение сам, и вторая фаза уезжания
        // читается как лаг. Договорённость: дисмисс ≤150 мс, показ/зум ≤300.
        // Порог вендора — ≤50 мс отключает анимацию, поэтому 100 — «быстрый
        // хвост», не обрубание. prefers-reduced-motion вендор обрабатывает
        // сам (showHideAnimationType 'none' обнуляет длительность независимо
        // от этих значений). Контракт: tests/lightbox-animation.test.js.
        hideAnimationDuration: 100,
        showAnimationDuration: 250,
        zoomAnimationDuration: 250,
    });
    _active = pswp;
    pswp.on('destroy', () => { if (_active === pswp) _active = null; });
    // Мёртвый тап после жестового закрытия: корень .pswp живёт всю closing
    // animation и перехватывает указатели. Ставить pointer-events:none на
    // корень (и даже на closingAnimationStart — тот диспатчится из _start()
    // через setTimeout, тик-два ПОСЛЕ close()) недостаточно: вендорный CSS
    // ЯВНО возвращает hit-тест потомкам — .pswp__content > * (сама картинка,
    // крупнейшая область, куда «на автомате» падает следующий тап) и
    // .pswp--ui-visible .pswp__hide-on-close (верхний бар в момент закрытия).
    // Инертный элемент без слушателей (вендор снимает их первой же строкой
    // close()) просто съедает тап. Поэтому на САМОМ раннем событии 'close'
    // (диспатчится синхронно в pswp.close(), до снятия слушателей и анимации)
    // делаем всё поддерево прозрачным для hit-теста: корень — inline, дыры
    // вендора — классом uris-pswp-closing (правила в style.css). Потерь
    // интерактивности нет: кнопки в окне закрытия всё равно мертвы, а тапы
    // уходят странице — «нажал на другое, оно открылось сразу»; новый
    // просмотрщик открывается поверх исчезающего (destroy старого защищён
    // guard'ом _active === pswp выше).
    pswp.on('close', () => {
        pswp.element.style.pointerEvents = 'none';
        pswp.element.classList.add('uris-pswp-closing');
        // Watchdog закрытия: вендорная развязка держит корень в DOM до
        // transitionend, а тот стартует через каскад setTimeout(0 → 30) с
        // фолбэком duration+500 — легально до ~1.2с после close(), на
        // нагруженной странице дольше. Хит-тест корень уже прозрачен (выше),
        // но каждое лишнее мгновение «невидимого» корня — окно для квирков
        // движка и чужих стилей (симптом: «анимация доигрывается на фоне,
        // клики не работают»). Здоровая развязка укладывается в ~250мс:
        // не дождались — доуничтожаем принудительно. destroy()
        // идемпотентен по isDestroying, DOM-слушатели вендор снял первой же
        // строкой close(), так что гонки с его таймерами нет.
        setTimeout(() => {
            if (pswp.element?.isConnected) {
                try { pswp.destroy(); } catch { /* корень уже снят вендором */ }
            }
        }, 400);
    });

    const syncFavUi = registerActionButtons(pswp, { items, chatId: chatIdResolved, root });
    pswp.init();
    localizeDefaultUi(pswp);
    registerContextMenu(pswp, { items, root, syncFavUi });
    syncFavUi?.();

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
 * (favorite / copy / crop → new card / save-as-ref / regen / delete);
 * reference items (actions: 'ref', from References and Generation) get
 * copy + crop — regen and delete make no sense for a reference and the record
 * lives in the editor.
 *
 * Returns the favorite-button state sync (noop in ref mode): the toggle lives
 * on the CURRENT slide, so the icon must follow swipe ('change') and the user's
 * own toggle (run calls it again after gallery-actions mutated the item).
 */
function registerActionButtons(pswp, ctx) {
    const refMode = ctx.items.some(item => item.__actions === 'ref');
    const syncFavUi = () => {
        const btn = pswp.element?.querySelector('.uris-pswp-fav');
        if (!btn) return;
        const item = ctx.items[pswp.currIndex];
        // Одиночные превью без карточки (id нет) — избранного не существует.
        btn.style.display = item?.id ? '' : 'none';
        const on = item?.favorite === true;
        btn.classList.toggle('uris-pswp-fav-on', on);
        const title = on ? 'Убрать из избранного' : 'В избранное';
        btn.title = title;
        btn.setAttribute('aria-label', title);
    };
    const buttons = refMode ? [
        { name: 'uris-copy', order: 30, icon: 'fa-copy', title: 'Копировать текст', danger: false, run: item => copyItemText(item) },
        { name: 'uris-crop', order: 31, icon: 'fa-crop-simple', title: 'Обрезать референс', danger: false, run: async item => { if (await cropReference(item)) pswp.close(); } },
    ] : [
        { name: 'uris-fav', order: 29, icon: 'fa-star', title: 'В избранное', danger: false,
            run: async item => { await toggleFavorite(item, ctx.root); syncFavUi(); } },
        { name: 'uris-copy', order: 30, icon: 'fa-copy', title: 'Копировать текст', danger: false, run: item => copyItemText(item) },
        { name: 'uris-copy-img', order: 35, icon: 'fa-image', title: 'Скопировать', danger: false, run: item => copyImageToClipboard(item) },
        { name: 'uris-crop', order: 31, icon: 'fa-crop-simple', title: 'Обрезать (в новую карточку)', danger: false, run: async item => { if (await cropGalleryImage(item, ctx.chatId, ctx.root)) pswp.close(); } },
        { name: 'uris-save-ref', order: 32, icon: 'fa-bookmark', title: 'Сохранить как референс', danger: false, run: item => saveAsReference(item) },
        { name: 'uris-regen', order: 33, icon: 'fa-rotate-right', title: 'Перегенерировать', danger: false, run: async item => { if (await regenerate(item, ctx.root, null)) pswp.close(); } },
        { name: 'uris-del', order: 34, icon: 'fa-trash', title: 'Удалить', danger: true, run: async item => { if (await deleteImage(item, ctx.chatId, ctx.root)) pswp.close(); } },
    ];
    pswp.on('uiRegister', () => {
        for (const button of buttons) {
            pswp.ui.registerElement({
                name: button.name,
                order: button.order,
                isButton: true,
                tagName: 'button',
                className: 'uris-pswp-act' + (button.name === 'uris-fav' ? ' uris-pswp-fav' : '') + (button.danger ? ' uris-pswp-act-danger' : ''),
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
    if (!refMode) pswp.on('change', syncFavUi);
    return refMode ? null : syncFavUi;
}

/**
 * Контекстное меню по картинке в просмотрщике: ПКМ (десктоп) и long-press
 * (тач) — bindCardContextMenu, тот же жест, что у карточек сетки. Пункты —
 * «Отредактировать промпт» и «Сгенерировать ещё»: правка промпта в тулбаре
 * недоступна в принципе, «ещё» дублирует реген одним жестом без прицеливания
 * в мелкую кнопку. Жест отвечает только на самой картинке (.pswp__img) —
 * ПКМ по тулбару/стрелкам/фону меню не открывает; у референсов
 * (__actions: 'ref') промпта нет — меню не открывается вовсе.
 */
function registerContextMenu(pswp, ctx) {
    bindCardContextMenu(pswp.element, (pos) => {
        if (pos.target?.closest?.('.pswp__img') == null) return;
        const item = ctx.items[pswp.currIndex];
        if (!item || item.__actions === 'ref') return;
        // Контракт тулбара: вьювер закрывается только при фактическом успехе —
        // отмена/ошибка остаются на экране вместе с тостом о причине.
        const closeOnOk = (promise) => { void Promise.resolve(promise).then(ok => { if (ok) pswp.close(); }); };
        // Контекст карточки (избранное/папки) существует только у картинок
        // с карточкой в галерее; одиночные превью получают только генерацию.
        const menuItems = item.id ? [
            { id: 'uris-ctx-fav', icon: item.favorite === true ? 'fa-star-half-stroke' : 'fa-star',
                label: item.favorite === true ? 'Убрать из избранного' : 'В избранное',
                onSelect: () => { void Promise.resolve(toggleFavorite(item, ctx.root)).then(() => ctx.syncFavUi?.()); } },
            { id: 'uris-ctx-folders', icon: 'fa-folder', label: 'Папки…',
                onSelect: () => { void assignGalleryFolders(item, ctx.root); } },
        ] : [];
        menuItems.push(
            { id: 'uris-ctx-dl', icon: 'fa-download', label: 'Скачать', onSelect: () => downloadImage(item) },
            { id: 'uris-ctx-copy-img', icon: 'fa-image', label: 'Скопировать', onSelect: () => copyImageToClipboard(item) },
            { id: 'uris-ctx-edit', icon: 'fa-pen', label: 'Отредактировать промпт…', onSelect: () => closeOnOk(editPromptAndRegenerate(item, ctx.root)) },
            { id: 'uris-ctx-more', icon: 'fa-rotate-right', label: 'Сгенерировать ещё', onSelect: () => closeOnOk(regenerate(item, ctx.root, null)) },
        );
        openCardActionMenu({
            title: item.prompt ? String(item.prompt).slice(0, 80) : 'Изображение',
            x: pos.x, y: pos.y,
            items: menuItems,
        });
    });
}

/** Stock UI titles are English; ST users get Russian. */
function localizeDefaultUi(pswp) {    const titles = [
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
