// @ts-check
/** Technical provider metadata shared by route, catalog, and adapter wiring. */
const POLLINATIONS_CONTRACT = 'pollinations-images';
const NAISTERA_CONTRACT = 'naistera';

export const PROVIDER_DESCRIPTORS = Object.freeze({
    [POLLINATIONS_CONTRACT]: Object.freeze({
        id: POLLINATIONS_CONTRACT,
        label: 'Pollinations',
        defaultEndpoint: 'https://gen.pollinations.ai',
        auth: Object.freeze({ required: true, scheme: 'bearer', tokenPrefix: 'sk_' }),
        operations: Object.freeze({
            generate: Object.freeze({ request: 'json', response: 'json', async: false }),
            edit: Object.freeze({ supported: false }),
        }),
        catalog: Object.freeze({ path: '/image/models', shape: 'array', auth: 'public' }),
        parameters: Object.freeze({
            quality: Object.freeze(['standard', 'hd', 'low', 'medium', 'high']),
            resolution: Object.freeze(['1k', '2k', '480p', '720p', '768p', '1080p']),
        }),
    }),
    // Naistera tokens are issued by the Telegram bot and have no documented
    // prefix (unlike Pollinations sk_/pk_), so auth only requires non-empty
    // bearer material and never pattern-matches the token shape.
    [NAISTERA_CONTRACT]: Object.freeze({
        id: NAISTERA_CONTRACT,
        label: 'Naistera',
        defaultEndpoint: 'https://naistera.org',
        auth: Object.freeze({ required: true, scheme: 'bearer', tokenPrefix: null }),
        operations: Object.freeze({
            // POST /api/generate answers either synchronously or with a job_id
            // that is polled on GET /api/generate/jobs/{job_id}.
            generate: Object.freeze({ request: 'json', response: 'json', async: true }),
            edit: Object.freeze({ supported: false }),
        }),
        catalog: Object.freeze({ path: '/api/models', shape: 'array', auth: 'bearer' }),
        parameters: Object.freeze({
            // From the /prompt constructor page; used only for validation,
            // the wire accepts whatever the API declares per model.
            aspectRatios: Object.freeze(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']),
            presets: Object.freeze(['digital', 'realism']),
        }),
        polling: Object.freeze({ intervalMs: 2500, maxMs: 0 }),  // maxMs 0 = connection timeoutMs is the deadline
    }),
});

export function getProviderDescriptor(contract) {
    return PROVIDER_DESCRIPTORS[contract] || null;
}
