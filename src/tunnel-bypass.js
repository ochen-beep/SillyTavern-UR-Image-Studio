// @ts-check
/**
 * Bypass headers for free dev-tunnel hosts that interpose a consent page in
 * front of "browser-looking" requests. The tunnels identify a browser solely
 * by its User-Agent, and URIS fetches with the real Chrome UA, so without this
 * every provider request behind such a tunnel hits the wall instead of the API.
 *
 * Symptoms without injection:
 *   - localtunnel (*.loca.lt, *.localtunnel.me): HTTP 511 "Network
 *     Authentication Required" with the "Tunnel website ahead!" HTML page —
 *     surfaces as "Model discovery failed (HTTP 511)" or "Chat Completions
 *     returned HTTP 511".
 *   - ngrok free (*.ngrok-free.app, *.ngrok.app, *.ngrok.dev): HTTP 200 with
 *     the ERR_NGROK_6024 interstitial and no CORS headers, so the browser
 *     masks the response and the user sees a phantom "blocked by CORS" error.
 *
 * Both services document a programmatic opt-out request header:
 *   - localtunnel: `bypass-tunnel-reminder` (printed on the consent page);
 *   - ngrok: `ngrok-skip-browser-warning` (free-plan docs forbid adding it
 *     server-side via traffic policy — only the client can send it).
 *
 * Scope discipline: headers are injected ONLY when the URL host matches, and a
 * subdomain is required (tunnels always live on `<id>.<domain>`). A custom
 * header makes a fetch non-simple and triggers a CORS preflight — harmless on
 * tunnels (their preflights pass through to the backend) but a gratuitous new
 * failure mode on ordinary endpoints (e.g. signed S3 media URLs that need no
 * preflight today). SillyTavern's /proxy/<url> middleware forwards request
 * headers verbatim — its removal list only strips host, cookie, origin,
 * referer, x-csrf-token, the x-forwarded- family and the sec-fetch- family —
 * so the bypass also reaches the upstream when delivery goes through the ST
 * CORS proxy.
 */

const TUNNEL_BYPASS = [
    { match: /\.(?:loca\.lt|localtunnel\.me)$/i, headers: { 'bypass-tunnel-reminder': '1' } },
    { match: /\.ngrok(?:-free)?\.(?:app|dev)$/i, headers: { 'ngrok-skip-browser-warning': '1' } },
];

/**
 * Service headers that must accompany a request to a tunnel-walled host.
 * Returns a fresh object each call; {} for anything that is not a known
 * tunnel host (including relative URLs and non-URL garbage).
 *
 * @param {string|URL|null|undefined} url
 * @returns {Record<string, string>}
 */
export function tunnelBypassHeaders(url) {
    if (!url) return {};
    let host;
    try {
        host = new URL(String(url)).hostname;
    } catch {
        return {}; // relative URL or not a URL at all — same-origin, no tunnel
    }
    for (const tunnel of TUNNEL_BYPASS) {
        if (tunnel.match.test(host)) return { ...tunnel.headers };
    }
    return {};
}
