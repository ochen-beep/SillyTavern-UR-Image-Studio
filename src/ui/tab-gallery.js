// @ts-check
/**
 * Gallery tab: grid of shared native image metadata with actions for
 * viewing, regenerating, copying the prompt, saving as a reference, and deleting.
 */
import { getCtx, escapeHtml, showInputModal, showConfirmModal } from '../core.js';
import { getGallery } from '../storage.js';
import { isStudioActive, resolveActiveChatId } from '../studio-scope.js';
import {
    createGalleryFolder, deleteGalleryFolder, updateGalleryFolder, listGalleryFolders,
    getGalleryViewPrefs, saveGalleryViewPrefs,
} from '../gallery-folders.js';
import { FOLDER_COLOR_PALETTE } from '../refs-library.js';
import { orderSidebarFolders } from './folder-picker.js';
import { showLightbox } from './lightbox.js';
import { openCardActionMenu, bindCardContextMenu } from './card-action-menu.js';

// Test-only viewer seam: fake-dom tests cannot load PhotoSwipe, so the click
// regression test swaps the viewer for a capture stub (same pattern as
// setRefStoreForTests in refs-library.js).
let _viewer = { showLightbox };
export function setViewerForTests(viewer) { _viewer = viewer; }
export function resetViewerForTests() { _viewer = { showLightbox }; }

// Gallery grid renders in chunks: the first batch mounts immediately, the rest
// append when the sentinel scrolls into view (no virtualization needed at this
// list size, but a 500-image chat must not drop 500 <img> at once).
const CHUNK_SIZE = 60;

// ── Pure helpers (exported for Node tests) ──

/**
 * Избранные карточки закрепляются наверху ленты; внутри обеих групп прежний
 * порядок (новые сверху — так их отдаёт индекс). Pure: новый массив.
 */
export function orderGalleryItems(items) {
    const list = Array.isArray(items) ? items : [];
    return [
        ...list.filter(it => it?.favorite === true),
        ...list.filter(it => !(it?.favorite === true)),
    ];
}

/** Фильтр активной папки режима «Папки»: 'all' | 'none' | id папки. Pure. */
export function filterGalleryByFolder(items, folderFilter) {
    const list = Array.isArray(items) ? items : [];
    if (!folderFilter || folderFilter === 'all') return list.slice();
    if (folderFilter === 'none') return list.filter(it => !Array.isArray(it?.folders) || it.folders.length === 0);
    return list.filter(it => Array.isArray(it?.folders) && it.folders.includes(folderFilter));
}

/** Счётчики чипов ленты папок: сколько карточек в каждой папке и без папок. Pure. */
export function galleryFolderCounts(items) {
    const byId = new Map();
    let none = 0;
    for (const it of (Array.isArray(items) ? items : [])) {
        const ids = Array.isArray(it?.folders) ? it.folders : [];
        if (!ids.length) none += 1;
        for (const id of ids) byId.set(id, (byId.get(id) || 0) + 1);
    }
    return { byId, none };
}

export async function render(root) {
    // On the welcome screen the gallery shows the studio scope: images
    // generated outside a chat (provenance.chatId === '__uris_studio__').
    const chatId = resolveActiveChatId();
    const studio = isStudioActive();
    const prefs = getGalleryViewPrefs();
    const allItems = orderGalleryItems(await getGallery(chatId));
    const folders = prefs.view === 'folders' ? await listGalleryFolders() : [];
    const items = filterGalleryByFolder(allItems, prefs.filter);
    if (root.__urisTabId && root.__urisTabId !== 'gallery') return;
    root.innerHTML = `
        <div class="uris-gallery">
            <div class="uris-gallery-toolbar">
                ${studio ? '<span class="uris-gallery-scope" title="Генерации без открытого чата">Студия</span>' : ''}
                <span id="urisGalleryCount">${items.length}</span>
                <div class="uris-gallery-viewswitch" role="group" aria-label="Режим галереи">
                    <button type="button" class="uris-viewswitch-btn${prefs.view === 'all' ? ' uris-viewswitch-btn-on' : ''}" data-view="all" title="Все картинки одной лентой">Все</button>
                    <button type="button" class="uris-viewswitch-btn${prefs.view === 'folders' ? ' uris-viewswitch-btn-on' : ''}" data-view="folders" title="Разложить по папкам">Папки</button>
                </div>
            </div>
            ${prefs.view === 'folders' ? folderBarHtml(folders, allItems, prefs) : ''}
            <div class="uris-gallery-grid" id="urisGalleryGrid"></div>
        </div>`;
    bindViewSwitch(root);
    if (prefs.view === 'folders') bindFolderBar(root, folders);
    const grid = root.querySelector('#urisGalleryGrid');
    if (!items.length) {
        grid.innerHTML = emptyState(prefs);
    } else {
        await appendChunk(grid, root, items, 0, chatId);
        await mountChunkLoader(root, grid, items, chatId);
    }
}

function bindViewSwitch(root) {
    root.querySelectorAll('.uris-viewswitch-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (getGalleryViewPrefs().view === btn.dataset.view) return;
            // Фильтр папки не имеет смысла в ленте «Все» — сбрасываем вместе с видом.
            saveGalleryViewPrefs({ view: btn.dataset.view, filter: 'all' });
            await render(root);
        });
    });
}

// ── Лента папок (режим «Папки») ──
// Горизонтальная лента чипов: «Все», «Без папки», определения папок со
// счётчиками, «＋» (создать) и «⋯» (сортировка). Действия папки — ПКМ/долгий
// тап по чипу (тот же жест, что у карточек и строк референсов).

function folderBarHtml(folders, allItems, prefs) {
    const { byId, none } = galleryFolderCounts(allItems);
    const ordered = orderSidebarFolders(folders, { sort: prefs.sort, countById: byId });
    const pseudoChip = (id, label, count) => `
        <button type="button" class="uris-gf-chip${prefs.filter === id ? ' uris-gf-chip-on' : ''}" data-gfolder="${id}">
            <span class="uris-folder-dot uris-folder-dot-mute"></span>
            <span class="uris-gf-name">${label}</span>
            <span class="uris-gf-count">${count}</span>
        </button>`;
    return `<div class="uris-gf-bar" id="urisGalleryFolderbar">
        ${pseudoChip('all', 'Все', allItems.length)}
        ${pseudoChip('none', 'Без папки', none)}
        ${ordered.map(folder => `
            <button type="button" class="uris-gf-chip${prefs.filter === folder.id ? ' uris-gf-chip-on' : ''}" data-gfolder="${escapeHtml(folder.id)}" title="${escapeHtml(folder.name)}">
                <span class="uris-folder-dot" style="background:${escapeHtml(folder.color)}"></span>
                <span class="uris-gf-name">${escapeHtml(folder.name)}</span>
                <span class="uris-gf-count">${byId.get(folder.id) || 0}</span>
            </button>`).join('')}
        <button type="button" class="uris-gf-chip uris-gf-add" title="Новая папка" aria-label="Новая папка"><i class="fa-solid fa-plus"></i></button>
        <button type="button" class="uris-gf-chip uris-gf-tools" title="Сортировка папок" aria-label="Сортировка папок"><i class="fa-solid fa-ellipsis"></i></button>
    </div>`;
}

function bindFolderBar(root, folders) {
    const bar = root.querySelector('#urisGalleryFolderbar');
    if (!bar) return;
    // Class-only селектор + ручной фильтр по data-gfolder: querySelector-хелпер
    // тестового fake-dom понимает только простые селекторы (см. folder-picker).
    bar.querySelectorAll('.uris-gf-chip').forEach(btn => {
        const id = btn.dataset.gfolder;
        if (!id) return;   // «＋»/«⋯» — у них data-gfolder нет
        btn.addEventListener('click', async () => {
            if (getGalleryViewPrefs().filter === id) return;
            saveGalleryViewPrefs({ filter: id });
            await render(root);
        });
        const folder = folders.find(f => f.id === id);
        if (folder) bindCardContextMenu(btn, ({ x, y }) => { void openGalleryFolderMenu(root, folder, x, y); });
    });
    bar.querySelector('.uris-gf-add')?.addEventListener('click', async () => {
        const name = await showInputModal('Имя папки:', 'Новая папка');
        if (!name) return;
        await createGalleryFolder(name);
        await render(root);
    });
    bar.querySelector('.uris-gf-tools')?.addEventListener('click', (e) => {
        const rect = typeof e.currentTarget?.getBoundingClientRect === 'function'
            ? e.currentTarget.getBoundingClientRect() : null;
        openGallerySortMenu(root, rect);
    });
}

const GALLERY_SORT_UI = [
    { sort: 'manual', label: 'Свой порядок' },
    { sort: 'name', label: 'По имени' },
    { sort: 'count', label: 'По количеству' },
];

/** Меню «⋯» ленты папок: порядок чипов (device-local pref, как у референсов). */
function openGallerySortMenu(root, rect) {
    const prefs = getGalleryViewPrefs();
    openCardActionMenu({
        title: 'Сортировка папок',
        x: rect ? Math.round(rect.left) : null,
        y: rect ? Math.round(rect.bottom + 4) : null,
        items: GALLERY_SORT_UI.map(item => ({
            id: `gfsort-${item.sort}`,
            icon: 'fa-arrow-down-wide-short',
            label: (prefs.sort === item.sort ? '✓ ' : '') + item.label,
            onSelect: async () => {
                saveGalleryViewPrefs({ sort: item.sort });
                await render(root);
            },
        })),
    });
}

/** ПКМ / долгий тап по чипу папки: переименовать, цвет, удалить. */
function openGalleryFolderMenu(root, folder, x = null, y = null) {
    openCardActionMenu({
        title: folder.name,
        x, y,
        items: [
            { id: 'gf-rename', icon: 'fa-pen', label: 'Переименовать…', onSelect: async () => {
                const name = await showInputModal('Имя папки:', folder.name);
                if (!name || name === folder.name) return;
                await updateGalleryFolder(folder.id, { name });
                await render(root);
            } },
            { id: 'gf-color', icon: 'fa-palette', label: 'Сменить цвет', onSelect: async () => {
                const index = Math.max(FOLDER_COLOR_PALETTE.indexOf(folder.color), 0);
                await updateGalleryFolder(folder.id, { color: FOLDER_COLOR_PALETTE[(index + 1) % FOLDER_COLOR_PALETTE.length] });
                await render(root);
            } },
            { id: 'gf-delete', icon: 'fa-trash', label: 'Удалить папку…', danger: true, onSelect: async () => {
                if (!await showConfirmModal(`Удалить папку «${folder.name}»?\n\nСами картинки останутся в галерее — только выпадут из этой папки.`)) return;
                await deleteGalleryFolder(folder.id);
                if (getGalleryViewPrefs().filter === folder.id) saveGalleryViewPrefs({ filter: 'all' });
                await render(root);
            } },
        ],
    });
}

function card(it, i) {
    const badge = it.saved ? '<span class="uris-saved-badge" title="Сохранено в ST">💾</span>' : '';
    // Избранное: золотая звезда в левом верхнем углу (💾 занял правый) +
    // подсветка карточки. Наверх ленты карточку ставит orderGalleryItems.
    const favOn = it.favorite === true;
    const favBadge = favOn ? '<span class="uris-fav-badge" title="В избранном"><i class="fa-solid fa-star"></i></span>' : '';
    // Название модели — градиентная подпись на нижней кромке миниатюры.
    // Legacy-карточки и карточки после reconcile модель не знают — подписи нет.
    const model = typeof it.modelId === 'string' ? it.modelId.trim() : '';
    const modelBadge = model
        ? `<span class="uris-model-badge" title="Модель: ${escapeHtml(model)}">${escapeHtml(model)}</span>`
        : '';
    const gotoBtn = it.sourceMsgId != null
        ? `<button class="uris-card-btn" data-act="goto" title="Перейти к посту-источнику" aria-label="Перейти к посту-источнику"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>`
        : '';
    // The image itself is the view trigger (the former expand button is gone);
    // a real <button> keeps Tab/Enter working. Dimensions prevent layout shift
    // and let the lightbox animate from this thumbnail. Grid loads the small
    // variant when one exists — the lightbox always opens the full image.
    const src = it.thumbPath || it.src;
    const dims = Number(it.width) > 0 && Number(it.height) > 0
        ? ` width="${Number(it.width)}" height="${Number(it.height)}"`
        : '';
    const favTitle = favOn ? 'Убрать из избранного' : 'В избранное';
    return `<div class="uris-card${favOn ? ' uris-card-fav' : ''}" data-id="${escapeHtml(it.id)}" data-idx="${i}">
        <button type="button" class="uris-card-img" data-act="view" title="Просмотр" aria-label="Просмотр"><img src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async"${dims}>${favBadge}${modelBadge}${badge}</button>
        <div class="uris-card-actions">
            <button class="uris-card-btn uris-card-btn-fav${favOn ? ' uris-card-btn-fav-on' : ''}" data-act="fav" title="${favTitle}" aria-label="${favTitle}"><i class="fa-solid fa-star"></i></button>
            <button class="uris-card-btn" data-act="regen" title="Перегенерировать" aria-label="Перегенерировать"><i class="fa-solid fa-rotate-right"></i></button>
            <button class="uris-card-btn" data-act="copy" title="Копировать текст" aria-label="Копировать текст"><i class="fa-solid fa-copy"></i></button>
            ${gotoBtn}
            <button class="uris-card-btn" data-act="saveRef" title="Сохранить как референс" aria-label="Сохранить как референс"><i class="fa-solid fa-bookmark"></i></button>
            <button class="uris-card-btn" data-act="del" title="Удалить" aria-label="Удалить"><i class="fa-solid fa-trash"></i></button>
        </div>
    </div>`;
}

/** Append one chunk of cards and bind only the newly added ones. */
async function appendChunk(grid, root, items, from, chatId) {
    const to = Math.min(items.length, from + CHUNK_SIZE);
    // Wrapper-div + appendChild instead of insertAdjacentHTML: same result in
    // browsers (appendChild moves the node), and parseable by the fake-dom
    // test harness. Iterate a snapshot — appendChild mutates wrapper.children.
    const wrapper = document.createElement('div');
    wrapper.innerHTML = items.slice(from, to).map((it, i) => card(it, from + i)).join('');
    for (const node of [...wrapper.children]) grid.appendChild(node);
    await bindCards(grid, root, items, chatId, from, to);
}

/**
 * Keep appending chunks while the sentinel is visible (fast scrolling, short
 * viewports). Without IntersectionObserver everything renders immediately.
 */
async function mountChunkLoader(root, grid, items, chatId) {
    if (grid.querySelectorAll('.uris-card').length >= items.length) return;
    const sentinel = document.createElement('div');
    sentinel.className = 'uris-gallery-sentinel';
    grid.parentElement?.insertBefore(sentinel, grid.nextSibling);
    const appendNext = async () => {
        const from = grid.querySelectorAll('.uris-card').length;
        if (from >= items.length) {
            observer?.disconnect();
            sentinel.remove();
            return;
        }
        await appendChunk(grid, root, items, from, chatId);
        if (grid.querySelectorAll('.uris-card').length >= items.length) {
            observer?.disconnect();
            sentinel.remove();
        }
    };
    // In-flight guard: appendChunk awaits bindCards, and a second
    // IntersectionObserver callback during that await re-read the same card
    // count and appended the same slice twice (duplicate cards on fast scroll).
    let appending = false;
    const guardedAppend = async () => {
        if (appending) return;
        appending = true;
        try { await appendNext(); }
        finally { appending = false; }
    };
    const observer = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void guardedAppend(); })
        : null;
    if (!observer) {
        while (grid.querySelectorAll('.uris-card').length < items.length) await appendNext();
        sentinel.remove();
        return;
    }
    observer.observe(sentinel);
}

function emptyState(prefs = { view: 'all', filter: 'all' }) {
    if (prefs.view === 'folders' && prefs.filter === 'none') {
        return '<div class="uris-gallery-empty">Все картинки уже разобраны по папкам.</div>';
    }
    if (prefs.view === 'folders' && prefs.filter !== 'all') {
        return '<div class="uris-gallery-empty">В этой папке пусто. Добавьте картинки через меню карточки — «Папки…».</div>';
    }
    return '<div class="uris-gallery-empty">Нет генераций. Перейдите во вкладку «Генерация».</div>';
}

/**
 * Action-menu items for one gallery card (the long-press/ПКМ menu). The same
 * handlers the card buttons use, resolved lazily to keep the module's dynamic
 * import of gallery-actions. Exported pure for tests.
 * @param {Object} item gallery card
 * @param {{ chatId: string, root: HTMLElement }} ctx
 */
export function galleryMenuItems(item, { chatId, root }) {
    const favOn = item?.favorite === true;
    const items = [
        { id: 'fav', icon: favOn ? 'fa-star-half-stroke' : 'fa-star', label: favOn ? 'Убрать из избранного' : 'В избранное',
            onSelect: async () => { const a = await import('./gallery-actions.js'); await a.toggleFavorite(item, root); } },
        { id: 'regen', icon: 'fa-rotate-right', label: 'Регенерировать',
            onSelect: async () => { const a = await import('./gallery-actions.js'); await a.regenerate(item, root, null); } },
        { id: 'copy', icon: 'fa-copy', label: 'Копировать промпт',
            onSelect: async () => { const a = await import('./gallery-actions.js'); await a.copyItemText(item); } },
        { id: 'copyImage', icon: 'fa-image', label: 'Скопировать картинку',
            onSelect: async () => { const a = await import('./gallery-actions.js'); await a.copyImageToClipboard(item); } },
    ];
    if (item?.sourceMsgId != null) {
        items.push({ id: 'goto', icon: 'fa-arrow-up-right-from-square', label: 'К посту-источнику',
            onSelect: () => gotoSourcePost(item.sourceMsgId) });
    }
    items.push(
        { id: 'folders', icon: 'fa-folder', label: 'Папки…',
            onSelect: async () => { const a = await import('./gallery-actions.js'); await a.assignGalleryFolders(item, root); } },
        { id: 'saveRef', icon: 'fa-bookmark', label: 'Сохранить как референс',
            onSelect: async () => { const a = await import('./gallery-actions.js'); await a.saveAsReference(item); } },
        // Вернуть браузерное «скачать файл»: жест перехвачен кастомным меню,
        // нативного пункта контекстного меню больше нет (downloadImage).
        { id: 'download', icon: 'fa-download', label: 'Скачать картинку',
            onSelect: async () => { const a = await import('./gallery-actions.js'); a.downloadImage(item); } },
        { id: 'del', icon: 'fa-trash', label: 'Удалить…', danger: true,
            onSelect: async () => { const a = await import('./gallery-actions.js'); await a.deleteImage(item, chatId, root); } },
    );
    return items;
}

/** Navigate the chat to the source post; shared by the card button and the menu. */
function gotoSourcePost(msgId) {
    if (msgId == null) { toastr?.info('Пост-источник не указан'); return; }
    const mes = document.querySelector(`.mes[mesid="${msgId}"]`);
    if (!mes) { toastr?.info('Пост не найден в чате (возможно удалён)'); return; }
    mes.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// root — корень ВКЛАДКИ (#urisBody), он нужен обработчикам для refreshRoot и
// просмотра; scopeEl — контейнер сетки, в котором ищутся карточки. Это разные
// элементы: смешение их давало «root is not defined» на клике по картинке
// (обработчики молча падали с ReferenceError — просмотр не открывался).
//
// Делегирование (2026-10-06, пункт 23): один click/contextmenu-обработчик на
// контейнер сетки вместо шести на каждую карточку — рендер большой галереи
// больше не ставит O(n) слушателей (innerHTML-вайп всё равно снимал старые).
async function bindCards(scopeEl, root, items, chatId) {
    const { copyItemText, saveAsReference, regenerate, deleteImage, toggleFavorite, assignGalleryFolders } = await import('./gallery-actions.js');
    if (scopeEl.dataset.delegated === '1') return;   // idempotent per render
    scopeEl.dataset.delegated = '1';
    const hitOf = (target) => {
        const cardEl = target?.closest?.('.uris-card');
        if (!cardEl || !scopeEl.contains(cardEl)) return null;
        const idx = parseInt(cardEl.dataset.idx, 10);
        return {
            cardEl,
            idx,
            it: () => items.find(x => x.id === cardEl.dataset.id),
        };
    };
    scopeEl.addEventListener('click', (e) => {
        const hit = hitOf(e.target);
        if (!hit) return;
        const act = e.target?.closest?.('[data-act]')?.dataset.act;
        e.stopPropagation();
        switch (act) {
            case 'view':
                _viewer.showLightbox(items, hit.idx, { chatId, root });
                break;
            case 'fav':
                void toggleFavorite(hit.it(), root);
                break;
            case 'copy':
                void copyItemText(hit.it());
                break;
            case 'regen':
                void regenerate(hit.it(), root, hit.cardEl.querySelector('[data-act="regen"]'));
                break;
            // Navigate to source post: scroll the chat to .mes[mesid="N"].
            case 'goto':
                gotoSourcePost(hit.it()?.sourceMsgId);
                break;
            case 'del':
                void deleteImage(hit.it(), chatId, root);
                break;
            case 'saveRef':
                void saveAsReference(hit.it());
                break;
            case 'folders':
                void assignGalleryFolders(hit.it(), root);
                break;
        }
    });
    // Долгий тап (телефон) / ПКМ (десктоп): меню действий карточки.
    bindCardContextMenu(scopeEl, ({ x, y, target }) => {
        const hit = hitOf(target);
        if (!hit) return;
        openCardActionMenu({ title: 'Карточка', items: galleryMenuItems(hit.it(), { chatId, root }), x, y });
    });
}
