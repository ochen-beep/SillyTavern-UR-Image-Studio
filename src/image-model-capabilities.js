// @ts-check
/**
 * Per-model image-geometry capabilities for the Google image family.
 *
 * A model id is not a capability manifest, but the resolution tiers ARE
 * documented per model, and getting this wrong is not cosmetic: an unsupported
 * `imageSize` can hard-fail the whole request, taking the aspect ratio down
 * with it. Two independent confirmations:
 *   - Google's model pages: "Gemini 3.1 Flash Lite Image only supports 1K
 *     resolution. (Note: 2K and 4K are unsupported)."
 *     (ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image)
 *   - new-api relay software clears `imageSize` for `nano-banana` and
 *     `gemini-2.5-flash-image` precisely because the upstream answered with an
 *     internal error instead of ignoring the field.
 * Live probe 2026-09-16 (new-api relay): lite + `image_size: "2K"` → HTTP 502
 * from the gateway, while the same request without the size returned an image.
 *
 * `null` means "no per-model knowledge" and must never gate a request: unknown
 * (custom, renamed, future) models keep the previous permissive behaviour.
 */

/** Resolution tiers the Gemini image API accepts, in ascending cost order. */
export const IMAGE_SIZE_TIERS = Object.freeze(['512', '1K', '2K', '4K']);

// Ordered: first match wins, so the more specific rules (lite, pro, alias with
// a generation suffix) must precede the catch-all "bare nano-banana" rule —
// otherwise `nano-banana-pro` is classified as the 2.x generation.
const GEMINI_IMAGE_SIZE_TABLE = [
    // Lite tier: 1K only, documented.
    [/flash[^/\s]*lite[^/\s]*image|image[^/\s]*lite/i, ['1K']],
    // 3.x pro: 1K/2K/4K.
    [/3[^/\s]*pro[^/\s]*image|nano[-_. ]?banana[-_. ]?pro/i, ['1K', '2K', '4K']],
    // Nano Banana 2.1 (gemini-nano-banana-2.1, relay alias nano-banana-2.1):
    // 1K/2K/4K — 512 остался эксклюзивом 3.1-flash (ai.google.dev, 2026-10).
    // Правило стоит ВЫШЕ nano-banana-2: суффикс ".1" обязан матчиться раньше,
    // иначе 2.1 унаследует несуществующий тир 512.
    [/nano[-_. ]?banana[-_. ]?2[._-]?\d/i, ['1K', '2K', '4K']],
    // 3.x flash image (incl. the "nano banana 2" aliases): 512/1K/2K/4K.
    [/3[^/\s]*flash[^/\s]*image|nano[-_. ]?banana[-_. ]?2/i, ['512', '1K', '2K', '4K']],
    // 2.x generation: aspectRatio exists, imageSize does not (the tier was
    // introduced with the 3.x models).
    [/(?:^|[\w-]+\/)gemini-2[._-]?\d[^/\s]*image|nano[-_. ]?banana(?![_. ]?(?:pro|2))/i, []],
];

/**
 * Resolution tiers a model accepts, or null when URIS has no knowledge of it.
 * `[]` is a real answer: the model has no size parameter at all.
 * @param {string} modelId
 * @returns {string[]|null}
 */
export function supportedImageSizesFor(modelId) {
    const model = String(modelId || '');
    if (!model) return null;
    for (const [pattern, tiers] of GEMINI_IMAGE_SIZE_TABLE) {
        if (pattern.test(model)) return [...tiers];
    }
    return null;
}

/**
 * Whether a requested resolution tier is supported by the model.
 * @param {string} modelId
 * @param {string} size requested tier, e.g. "2K"
 * @returns {true|false|null} null = unknown, do not gate
 */
export function imageSizeSupported(modelId, size) {
    const tiers = supportedImageSizesFor(modelId);
    if (tiers === null) return null;
    return tiers.includes(String(size || '').trim());
}

/**
 * Human-readable reason for a dropped size, or null when nothing was dropped.
 * Callers use it to build their own warning entry.
 * @param {string} modelId
 * @param {string} size
 * @returns {string|null}
 */
export function unsupportedImageSizeReason(modelId, size) {
    const tiers = supportedImageSizesFor(modelId);
    if (tiers === null) return null;
    const wanted = String(size || '').trim();
    if (!wanted || tiers.includes(wanted)) return null;
    return tiers.length
        ? `модель ${modelId} поддерживает только ${tiers.join('/')}`
        : `модель ${modelId} не имеет параметра размера`;
}
