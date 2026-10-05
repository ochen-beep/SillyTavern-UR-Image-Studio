// @ts-check
import { imageResultFromValue, providerError, readJsonResponse, authProfileFor, referencesFor, requireInvocation, diagnosticRequestOptions, ASPECT_SIZES } from './image-base.js';
import { resolveEndpoint } from '../endpoint-utils.js';
import { getProviderDescriptor } from '../provider-descriptors.js';

const POLLINATIONS_DESCRIPTOR = getProviderDescriptor('pollinations-images');
const QUALITY_VALUES = new Set(POLLINATIONS_DESCRIPTOR?.parameters?.quality || []);
const RESOLUTION_VALUES = new Set(POLLINATIONS_DESCRIPTOR?.parameters?.resolution || []);

function pollinationsAuthError(code, message) {
    const error = providerError(code, message);
    error.authCode = code === 'POLLINATIONS_TOKEN_REQUIRED' ? 'AUTH_REQUIRED' : 'AUTH_INVALID';
    if (code === 'POLLINATIONS_TOKEN_REQUIRED') error.reauthRequired = true;
    return error;
}

export function validatePollinationsToken(value) {
    const token = typeof value === 'string' ? value.trim() : '';
    if (!token) throw pollinationsAuthError('POLLINATIONS_TOKEN_REQUIRED', 'Pollinations requires an sk_ access token in the connection Key field.');
    if (/^pk_/i.test(token)) {
        throw pollinationsAuthError('POLLINATIONS_TOKEN_INVALID', 'URIS accepts only a scoped sk_ Pollinations access token. pk_ is intentionally unsupported here (OAuth App Key or legacy publishable key).');
    }
    if (!/^sk_[^\s]+$/i.test(token)) {
        throw pollinationsAuthError('POLLINATIONS_TOKEN_INVALID', 'Pollinations generation requires a valid sk_ access token.');
    }
    return token;
}

function generationUrl(endpoint) {
    return `${resolveEndpoint(POLLINATIONS_DESCRIPTOR, endpoint)}${POLLINATIONS_DESCRIPTOR.endpoint.generationPath}`;
}

function supports(route, parameter) {
    const declared = route?.capabilities?.supportedParameters;
    return !Array.isArray(declared) || declared.length === 0 || declared.includes(parameter);
}

function quality(route, value) {
    if (!QUALITY_VALUES.has(value) || !supports(route, 'quality')) return undefined;
    const declared = route?.capabilities?.qualityValues;
    return Array.isArray(declared) && !declared.includes(value) ? undefined : value;
}

function body(route, request) {
    const payload = {
        model: route.modelId,
        prompt: String(request?.prompt || ''),
        n: 1,
    };
    const size = ASPECT_SIZES.get(request?.aspectRatio);
    if (size && supports(route, 'size')) payload.size = size;
    if (typeof request?.imageSize === 'string' && supports(route, 'resolution')) {
        const requestedResolution = request.imageSize.trim().toLowerCase();
        const declared = Array.isArray(route?.capabilities?.imageSizes)
            ? route.capabilities.imageSizes.map(value => String(value).toLowerCase())
            : null;
        if (RESOLUTION_VALUES.has(requestedResolution) && (!declared || declared.includes(requestedResolution))) {
            payload.resolution = requestedResolution;
        }
    }
    const selectedQuality = quality(route, request?.quality);
    if (selectedQuality) payload.quality = selectedQuality;
    if (typeof request?.safe === 'boolean' && supports(route, 'safe')) payload.safe = request.safe;
    return payload;
}

function parse(payload) {
    const first = Array.isArray(payload?.data) ? payload.data[0] : null;
    if (typeof first?.b64_json === 'string' && first.b64_json) {
        return imageResultFromValue(first.b64_json, first.media_type || first.mime_type || first.content_type || null);
    }
    if (typeof first?.url === 'string' && first.url) return imageResultFromValue(first.url);
    throw providerError('UPSTREAM_RESPONSE_INVALID', 'Pollinations returned a successful response without an image.');
}

export async function generatePollinationsImage(input) {
    const { endpoint, apiKey, route, request, transport, signal, connection = {}, diagnostic = null } = requireInvocation(input);
    const token = validatePollinationsToken(apiKey);
    const references = referencesFor(request);
    if (references.length) throw providerError('REFERENCES_UNSUPPORTED', 'Pollinations image generation does not accept references in this route.');
    const payload = body(route, request);
    const response = await transport.requestJson(
        generationUrl(endpoint),
        diagnosticRequestOptions({
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal,
        }, diagnostic, {
            bodyKind: 'json',
            wireFields: Object.keys(payload),
            omittedFields: [
                'references',
                'response_format',
                ...(typeof request?.safe === 'boolean' && supports(route, 'safe') ? [] : ['safe']),
            ],
        }),
        route,
        connection.timeoutMs,
    );
    return parse(await readJsonResponse(response, 'Pollinations Images', authProfileFor('pollinations-images')));
}
