// @ts-check
/**
 * Десктопная прокрутка таб-бара (#urisTabs): колесо мыши и drag-to-scroll.
 *
 * Контекст бага: на десктопе .uris-tabs имел overflow-x: visible — при узком
 * плавающем окне flex-вкладки упираются в min-content и переполняют бар, а
 * .uris-window { overflow: hidden } обрезает хвостовые вкладки («Мост»,
 * «Медиа», «Настройки»). Ни колесо мыши, ни перетаскивание бар не двигали:
 * вертикальный wheel уходил в body, drag по кнопкам ничего не делал.
 * Мобильный режим таким не страдает — там overflow-x: auto + touch-action: pan-x.
 *
 * Решение: базовое CSS-правило делает бар скролл-контейнером (overflow-x: auto,
 * скроллбар скрыт как на мобильном), а этот модуль добавляет:
 *   1) вертикальное колесо → горизонтальный скролл бара;
 *   2) drag-to-scroll левой кнопкой с порогом, чтобы обычный клик по вкладке
 *      продолжал переключать её, а клик после реального перетаскивания — нет.
 * События навешиваются на сам бар и переживают renderTabs() (innerHTML
 * пересоздаёт только кнопки-детей, не контейнер).
 */

/** Порог в px, после которого mousedown+move считается перетаскиванием, а не кликом. */
const DRAG_THRESHOLD_PX = 5;

/**
 * @param {HTMLElement} bar контейнер #urisTabs
 * @param {Document} [doc] документ для mousemove/mouseup (draggable за пределы бара)
 * @returns {() => void} cleanup: снимает все обработчики
 */
export function bindTabBarScroll(bar, doc) {
    if (!bar) return () => {};
    const ownerDoc = doc ?? bar.ownerDocument ?? globalThis.document ?? null;
    const canScroll = () => bar.scrollWidth > bar.clientWidth + 1;

    const onWheel = (e) => {
        if (!canScroll()) return; // нечего скроллить — событие идёт скроллу body
        // Тачпады шлют deltaX; обычное колесо — deltaY. Берём доминирующую ось.
        // deltaMode: 1 — строки (≈33px), 2 — страницы (≈ ширина бара).
        const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? Math.max(1, bar.clientWidth) : 1;
        const delta = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
        if (!delta) return;
        const max = bar.scrollWidth - bar.clientWidth;
        // Бар упёрся в край в этом направлении — не глотаем событие, пусть
        // его получит скролл-контейнер выше (тело окна).
        if ((delta > 0 && bar.scrollLeft >= max) || (delta < 0 && bar.scrollLeft <= 0)) return;
        e.preventDefault();
        bar.scrollLeft = Math.max(0, Math.min(max, bar.scrollLeft + delta));
    };

    let active = false;
    let moved = false;
    let startX = 0;
    let startScroll = 0;

    const onMouseDown = (e) => {
        if (e.button !== 0 || !canScroll()) return;
        active = true;
        moved = false;
        startX = e.clientX;
        startScroll = bar.scrollLeft;
        // Не даём начать выделение текста на кнопках вкладок. Click при этом
        // не отменяется — переключение вкладок без драга работает как раньше.
        e.preventDefault();
    };
    const onMouseMove = (e) => {
        if (!active) return;
        const dx = e.clientX - startX;
        if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
        moved = true;
        bar.scrollLeft = startScroll - dx;
    };
    const onMouseUp = (ev) => {
        active = false;
        // Жест, брошенный мышью ВНЕ бара: click на баре за ним не последует
        // (цель click — общий предок mousedown/mouseup), а флаг подавления
        // должен умереть вместе с жестом. Иначе он «переживёт» до ближайшего
        // mousedown на баре и проглотит клавиатурную активацию вкладки
        // (Enter/Space диспатчат click без mousedown). mouseup внутри бара
        // флаг сохраняет — его click ещё придёт и должен быть съеден.
        if (moved && ev?.target != null && bar.contains?.(ev.target) === false) moved = false;
    };
    // Click идёт после mouseup и всплывает от кнопки вкладки; capture-фаза на
    // баре срабатывает раньше bubble-обработчиков кнопок и гасит клик,
    // если перед ним был реальный драг. Флаг сбрасывается на mousedown,
    // поэтому «съеденный» клик не ломает следующий честный клик.
    const onClickCapture = (e) => {
        if (!moved) return;
        moved = false;
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    };

    bar.addEventListener('wheel', onWheel, { passive: false });
    bar.addEventListener('mousedown', onMouseDown);
    bar.addEventListener('click', onClickCapture, true);
    ownerDoc?.addEventListener('mousemove', onMouseMove);
    ownerDoc?.addEventListener('mouseup', onMouseUp);

    return () => {
        bar.removeEventListener('wheel', onWheel);
        bar.removeEventListener('mousedown', onMouseDown);
        bar.removeEventListener('click', onClickCapture, true);
        ownerDoc?.removeEventListener('mousemove', onMouseMove);
        ownerDoc?.removeEventListener('mouseup', onMouseUp);
    };
}
