// @ts-check
/**
 * Manifest-driven wire parameter resolution for OpenAI-compatible image
 * gateways (the openai-images dialect).
 *
 * One gateway hosts models with different geometry vocabularies. gpt-image-*
 * speaks the OpenAI size taxonomy (1024x1024 | 1536x1024 | 1024x1536);
 * Seedream models accept model-specific WxH resolutions or literal aspect
 * strings; nano-banana accepts `aspect_ratio` and silently ignores `size`.
 * Sending a taxonomy value the model does not declare is not an error for the
 * gateway — it is dropped, and the user's «Стороны» choice is lost while the
 * request still succeeds (observed on NanoGpt 2026-09: every non-1:1 choice
 * collapsed to the model's default square).
 *
 * The fix is data, not more per-provider tables. When the connection's catalog
 * probe stored the model's own vocabulary (route.capabilities.imageSizes /
 * supportedParameters — published by NanoGpt and OpenRouter), the resolver
 * picks the wire parameter from that manifest. Without a manifest it falls
 * back to the static family table, so unknown gateways behave exactly as
 * before. A new provider (or a new model on an existing one) that publishes a
 * manifest therefore needs no code change at all.
 *
 * Resolution order for a requested aspect ratio:
 *   1. `capabilities.aspectRatios` (explicit ratio enum)  → aspect_ratio
 *   2. `capabilities.imageSizes` contains the ratio literal ("16:9") → size
 *      (some gateways take aspect strings as size values, e.g.
 *      bytedance/seedream-v5.0-pro)
 *   3. `capabilities.imageSizes` contains WxH resolutions → nearest by ratio,
 *      ties resolved to the smaller canvas
 *   4. `capabilities.supportedParameters` includes 'aspect_ratio' → aspect_ratio
 *   5. family fallback table (gpt-image / dall-e static taxonomy)
 *   6. nothing — the caller reports a dropped parameter instead of guessing
 *
 * Nearest-WxH is always sent even when the deviation is large: it is the best
 * the model can do, and the post-generation aspect check (aspectDeviates in
 * image-api.js) reports the factual canvas either way.
 */

const WxH_PATTERN = /^(\d{2,5})x(\d{2,5})$/;
const RATIO_PATTERN = /^(\d{1,4}):(\d{1,4})$/;

/** w/h as a number, or null when the value is not a ratio-shaped string. */
function ratioOf(value) {
    const match = RATIO_PATTERN.exec(String(value || ''));
    if (match) {
        const w = Number(match[1]);
        const h = Number(match[2]);
        return w > 0 && h > 0 ? w / h : null;
    }
    const wxh = WxH_PATTERN.exec(String(value || ''));
    if (wxh) {
        const w = Number(wxh[1]);
        const h = Number(wxh[2]);
        return w > 0 && h > 0 ? w / h : null;
    }
    return null;
}

function capabilityList(route, name) {
    const values = route?.capabilities?.[name];
    return Array.isArray(values) ? values.map(value => String(value || '').trim()).filter(Boolean) : null;
}

function manifestSupports(route, parameter) {
    const declared = capabilityList(route, 'supportedParameters');
    return Array.isArray(declared) ? declared.includes(parameter) : false;
}

/**
 * Pick the manifest WxH entry closest to the requested ratio. Distance is
 * compared on the ratio scale so 21:9 vs 16:9 does not drown in pixel counts;
 * equal-ratio candidates (2560x1440 vs 4096x2304) resolve to the smaller
 * canvas — same shape, cheaper, and the user can still ask for a larger tier
 * through imageSize where the gateway supports one.
 */
function nearestWxH(sizes, requestedRatio) {
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestArea = Number.POSITIVE_INFINITY;
    for (const size of sizes) {
        const ratio = ratioOf(size);
        if (ratio == null) continue;
        const distance = Math.abs(Math.log(requestedRatio) - Math.log(ratio));
        const area = size.split('x').reduce((product, part) => product * Number(part), 1);
        if (distance < bestDistance || (distance === bestDistance && area < bestArea)) {
            best = size;
            bestDistance = distance;
            bestArea = area;
        }
    }
    return best;
}

/**
 * Resolve the wire geometry for an aspect-ratio request against the route's
 * manifest, falling back to the dialect's static table.
 *
 * @param {object} args
 * @param {object} [args.route] — dispatch-plan route (capabilities optional)
 * @param {string} [args.aspectRatio] — e.g. '16:9'; empty = leave geometry out
 * @param {Map<string,string>} [args.fallbackTable] — static aspect → size map
 * @returns {{param:'size'|'aspect_ratio'|null, value:string|null, source:string}}
 */
export function resolveWireGeometry({ route, aspectRatio, fallbackTable }) {
    const requested = String(aspectRatio || '').trim();
    if (!requested) return { param: null, value: null, source: 'unspecified' };
    const requestedRatio = ratioOf(requested);

    const manifestRatios = capabilityList(route, 'aspectRatios');
    if (manifestRatios && manifestRatios.includes(requested)) {
        return { param: 'aspect_ratio', value: requested, source: 'manifest-aspect-list' };
    }

    const imageSizes = capabilityList(route, 'imageSizes') || [];
    if (RATIO_PATTERN.test(requested) && imageSizes.includes(requested)) {
        // Literal aspect value the gateway accepts as a size (seedream-v5.0-pro).
        return { param: 'size', value: requested, source: 'manifest-size-exact' };
    }
    const sizes = imageSizes.filter(value => WxH_PATTERN.test(value));
    if (sizes.length && requestedRatio != null) {
        const nearest = nearestWxH(sizes, requestedRatio);
        if (nearest) return { param: 'size', value: nearest, source: 'manifest-size-nearest' };
    }

    if (manifestSupports(route, 'aspect_ratio')) {
        return { param: 'aspect_ratio', value: requested, source: 'manifest-aspect-param' };
    }

    const fallback = fallbackTable instanceof Map ? fallbackTable.get(requested) : null;
    if (fallback) return { param: 'size', value: fallback, source: 'static-table' };
    return { param: null, value: null, source: 'unmapped' };
}

/**
 * The quality value that should reach the wire, or undefined to omit it.
 * 'auto' is always omitted — it IS the provider default, and gateways exist
 * that reject the explicit value outright (apihub 400 "quality is not
 * supported", 2026-09). When the manifest declares a quality vocabulary, a
 * value outside it is dropped; the caller turns that into a paramWarning.
 * @param {object} [route]
 * @param {unknown} quality
 * @param {Set<string>} acceptedValues — the dialect's accepted input scale
 * @returns {string|undefined}
 */
export function resolveWireQuality(route, quality, acceptedValues) {
    if (typeof quality !== 'string' || !quality) return undefined;
    if (quality === 'auto') return undefined;
    const declared = capabilityList(route, 'qualityValues');
    if (declared && !declared.includes(quality)) return undefined;
    return acceptedValues instanceof Set && acceptedValues.has(quality) ? quality : undefined;
}
