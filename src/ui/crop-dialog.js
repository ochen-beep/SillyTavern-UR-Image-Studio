// @ts-check
/**
 * Reference crop dialog: pick a region, get a cropped PNG Blob.
 *
 * Croppr is vendored as ESM (src/vendor/croppr.esm.js) but imported only when
 * the dialog actually opens: the vendored script touches `window` at module
 * scope, and a static import would break Node tests importing this module's
 * pure helpers.
 *
 * Chrome is the mobile-safe .uris-picker-overlay family (explicit top/left +
 * width/height — see the .uris-picker-overlay comment in style.css);
 * .uris-crop-overlay raises z-index to 100100 so the dialog can open above an
 * open PhotoSwipe viewer (save-as-reference flow).
 *
 * Result: `{ blob, width, height }` on crop, `{ skip: true }` when the user
 * chose "use as is" (allowSkip), `null` on cancel.
 */

export const CROP_PRESETS = [
    { id: 'free', label: 'Свободно', ratio: null },
    { id: '1:1', label: '1:1', ratio: 1 },
    { id: '3:4', label: '3:4', ratio: 3 / 4 },  // пул рендерит тайлы 3:4
];

/**
 * Integer region fully inside the image, minimum 1×1. A 1px clamp against the
 * right/bottom edges keeps drawImage inside the source (a 0-width crop would
 * produce an empty blob).
 */
export function clampCropRegion(region, naturalWidth, naturalHeight) {
    const w = Math.max(1, Math.round(Number(naturalWidth) || 0));
    const h = Math.max(1, Math.round(Number(naturalHeight) || 0));
    const x = Math.max(0, Math.min(Math.round(Number(region?.x) || 0), w - 1));
    const y = Math.max(0, Math.min(Math.round(Number(region?.y) || 0), h - 1));
    const width = Math.max(1, Math.min(Math.round(Number(region?.width) || 0), w - x));
    const height = Math.max(1, Math.min(Math.round(Number(region?.height) || 0), h - y));
    return { x, y, width, height };
}

/**
 * Normalize a crop source into something an <img> can display.
 * File/Blob get an object URL (revoked by the caller via `revoke`).
 *
 * @param {File|Blob|string} source
 * @returns {{src: string, revoke: () => void}}
 */
export function normalizeCropSource(source) {
    if (typeof source === 'string') return { src: source, revoke: () => {} };
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const url = URL.createObjectURL(source);
        return { src: url, revoke: () => { try { URL.revokeObjectURL(url); } catch { /* already gone */ } } };
    }
    throw new Error('crop source must be a File, Blob, or URL string');
}

/**
 * Open the crop dialog.
 *
 * @param {{source: File|Blob|string, allowSkip?: boolean, presets?: typeof CROP_PRESETS}} opts
 * @returns {Promise<{blob: Blob, width: number, height: number}|{skip: true}|null>}
 */
export async function openCropDialog(opts = {}) {
    const { source, allowSkip = false, presets = CROP_PRESETS } = opts;
    if (source == null) return null;
    const normalized = normalizeCropSource(source);
    const { lockBodyScroll, unlockBodyScroll } = await import('./window.js');

    let croppr = null;
    let settle;
    const finished = new Promise(resolve => { settle = resolve; });

    const overlay = document.createElement('div');
    overlay.className = 'uris-picker-overlay uris-crop-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Обрезка изображения');
    overlay.innerHTML = `
        <div class="uris-picker-dialog uris-crop-dialog">
            <h4>Обрезать изображение</h4>
            <div class="uris-refs-filterbar">
                <div class="uris-refs-chips uris-scroll-x uris-crop-presets"></div>
            </div>
            <div class="uris-crop-stage" id="urisCropStage">
                <img alt="" class="uris-crop-img">
            </div>
            <div class="uris-picker-actions">
                <button type="button" class="uris-btn uris-btn-ghost uris-crop-cancel">Отмена</button>
                ${allowSkip ? '<button type="button" class="uris-btn uris-btn-ghost uris-crop-skip">Без обрезки</button>' : ''}
                <button type="button" class="uris-btn uris-btn-primary uris-crop-ok">Обрезать</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    lockBodyScroll();

    const imgEl = overlay.querySelector('.uris-crop-img');
    imgEl.src = normalized.src;

    const cleanup = () => {
        document.removeEventListener('keydown', onKey, true);
        try { croppr?.destroy(); } catch { /* already torn down */ }
        croppr = null;
        normalized.revoke();
        overlay.remove();
        unlockBodyScroll();
    };
    const onKey = (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            settle(null);
        }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.querySelector('.uris-crop-cancel').addEventListener('click', () => settle(null));
    overlay.querySelector('.uris-crop-skip')?.addEventListener('click', () => settle({ skip: true }));

    const renderPresets = (activeId) => {
        const host = overlay.querySelector('.uris-crop-presets');
        host.innerHTML = presets.map(p =>
            `<span class="uris-folder-chip ${p.id === activeId ? 'uris-folder-chip-on' : ''}" data-preset="${p.id}">${p.label}</span>`).join('');
        host.querySelectorAll('[data-preset]').forEach(chip => {
            chip.addEventListener('click', () => {
                const preset = presets.find(p => p.id === chip.dataset.preset);
                if (preset) void buildCroppr(preset, chip.dataset.preset);
            });
        });
    };

    const buildCroppr = async (preset, activeId) => {
        renderPresets(activeId);
        // destroy() restores the anchor <img>; a fresh instance rebuilds its
        // own DOM from it — that's how preset ratios switch.
        try { croppr?.destroy(); } catch { /* first build */ }
        croppr = null;
        const { default: Croppr } = await import('../vendor/croppr.esm.js');
        croppr = new Croppr(imgEl, {
            aspectRatio: preset.ratio ?? undefined,
            startSize: [70, '%'],
        });
    };

    try {
        await new Promise((resolve, reject) => {
            imgEl.onload = resolve;
            imgEl.onerror = () => reject(new Error('Не удалось загрузить изображение для обрезки'));
            if (imgEl.complete && imgEl.naturalWidth > 0) resolve();
        });
        await buildCroppr(presets[0], presets[0].id);

        overlay.querySelector('.uris-crop-ok').addEventListener('click', async () => {
            try {
                const value = croppr.getValue('real');
                const region = clampCropRegion(value, imgEl.naturalWidth, imgEl.naturalHeight);
                const canvas = document.createElement('canvas');
                canvas.width = region.width;
                canvas.height = region.height;
                canvas.getContext('2d').drawImage(imgEl, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
                const blob = await new Promise((resolve, reject) =>
                    canvas.toBlob(b => b ? resolve(b) : reject(new Error('Не удалось обрезать: изображение недоступно для чтения (CORS)')), 'image/png'));
                settle({ blob, width: region.width, height: region.height });
            } catch (e) {
                toastr?.error?.(e?.message || String(e), 'UR Image Studio');
            }
        });

        const result = await finished;
        cleanup();
        return result;
    } catch (e) {
        cleanup();
        toastr?.error?.(e?.message || String(e), 'UR Image Studio');
        return null;
    }
}
