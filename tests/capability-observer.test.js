// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyOperation,
  classifyOutcome,
  formatObservationLog,
  observeCapabilityAttempt,
} from '../src/capability-observer.js';
import { providerError, ImageProviderError } from '../src/providers/image-base.js';

// The observer is diagnostic-only: it classifies one dispatch attempt and logs
// a line. It persists nothing, so these tests need no storage fixture.

// core.js reads the ST context for its logger.
globalThis.SillyTavern = {
  getContext: () => ({
    extensionSettings: {},
    saveSettingsDebounced: () => {},
    getRequestHeaders: () => ({}),
  }),
};

const baseRoute = {
  source: 'openai-models',
  modelId: 'gpt-image-1',
  generationContract: 'openai-images',
  contractVersion: 1,
  bodyKind: 'json',
  proxyEligible: true,
  directCors: 'preferred',
};

const geminiRoute = {
  source: 'gemini-models',
  modelId: 'gemini-flash-image',
  generationContract: 'gemini-native',
  contractVersion: 1,
  bodyKind: 'json',
  proxyEligible: true,
  directCors: 'preferred',
};

test('classifyOperation maps openai-images without references to generate / none / direct', () => {
  const out = classifyOperation(baseRoute, { references: [] });
  assert.deepEqual(out, { operation: 'generate', referenceMode: 'none', delivery: 'direct' });
});

test('classifyOperation maps openai-images with editProtocol json to edit-json / json-data-url', () => {
  const out = classifyOperation(baseRoute, { references: [{ id: 'r1' }, { id: 'r2' }] }, { editProtocol: 'json' });
  assert.equal(out.operation, 'edit-json');
  assert.equal(out.referenceMode, 'json-data-url');
  assert.equal(out.delivery, 'direct');
});

test('classifyOperation defaults to multipart edits when the connection declares no editProtocol', () => {
  // Multipart is the conservative OpenAI baseline: it is the only /images/edits
  // dialect every observed proxy accepted. Model identity must NOT flip this -
  // a gpt-image-* name told us nothing about the wire protocol.
  const out = classifyOperation(baseRoute, { references: [{ id: 'r1' }] });
  assert.equal(out.operation, 'edit-multipart', 'unknown protocol must fall back to multipart, not JSON');
  assert.equal(out.referenceMode, 'multipart');
  assert.equal(out.delivery, 'direct');
});

test('classifyOperation ignores model identity when choosing the edit dialect', () => {
  const prefixedRoute = { ...baseRoute, modelId: 'openai/gpt-image-2' };
  const asJson = classifyOperation(prefixedRoute, { references: [{ id: 'r1' }] }, { editProtocol: 'json' });
  const asMultipart = classifyOperation(prefixedRoute, { references: [{ id: 'r1' }] }, { editProtocol: 'multipart' });
  assert.equal(asJson.operation, 'edit-json');
  assert.equal(asMultipart.operation, 'edit-multipart', 'same model, different connection -> different dialect');
});

test('classifyOperation maps dall-e with multipart-edits to edit-multipart / multipart / direct', () => {
  const dalleRoute = { ...baseRoute, modelId: 'dall-e-2' };
  const out = classifyOperation(dalleRoute, { references: [{ id: 'r1' }] }, { editProtocol: 'multipart' });
  assert.equal(out.operation, 'edit-multipart');
  assert.equal(out.referenceMode, 'multipart');
  assert.equal(out.delivery, 'direct');
});

test('classifyOperation routes multipart transport through direct even if proxyEligible drift', () => {
  const multipartRoute = { ...baseRoute, modelId: 'dall-e-2', transport: { bodyKind: 'multipart', proxyEligible: false, directCors: 'required' } };
  const out = classifyOperation(multipartRoute, { references: [{ id: 'r1' }] });
  assert.equal(out.delivery, 'direct');
  assert.equal(out.operation, 'edit-multipart');
  assert.equal(out.referenceMode, 'multipart');
});

test('classifyOperation honours editProtocol json over a multipart-declared route', () => {
  const multipartRoute = { ...baseRoute, transport: { bodyKind: 'multipart', proxyEligible: false, directCors: 'required' } };
  const out = classifyOperation(multipartRoute, { references: [{ id: 'r1' }] }, { editProtocol: 'json' });
  assert.equal(out.operation, 'edit-json');
  assert.equal(out.referenceMode, 'json-data-url');
  assert.equal(out.delivery, 'direct');
});

test('classifyOperation maps chat-completions references to multimodal-data-url', () => {
  const chatRoute = { ...baseRoute, generationContract: 'chat-completions' };
  const out = classifyOperation(chatRoute, { references: [{ id: 'r1' }] });
  assert.equal(out.operation, 'chat-image');
  assert.equal(out.referenceMode, 'multimodal-data-url');
});

test('classifyOperation maps gemini-native references to inline-data', () => {
  const out = classifyOperation(geminiRoute, { references: [{ id: 'r1' }] });
  assert.equal(out.operation, 'gemini-inline');
  assert.equal(out.referenceMode, 'inline-data');
});

test('classifyOperation recognises explicit initialDelivery proxy marker', () => {
  const route = { ...baseRoute, transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred', initialDelivery: 'proxy' } };
  const out = classifyOperation(route, { references: [] });
  assert.equal(out.delivery, 'proxy');
});

test('classifyOperation prefers the dispatcher delivery stamp over the pre-dispatch route', () => {
  // The pipeline observes with the route as persisted, but image-api.js may
  // dispatch through the ST /proxy/ because of the connection-level
  // useCorsProxy opt-in and stamps that decision onto request.delivery. The
  // observed line must match the transport log ('via proxy'), not the route.
  const out = classifyOperation(baseRoute, { references: [], delivery: 'proxy' });
  assert.equal(out.delivery, 'proxy');
  // Stamp wins in the other direction too: a proxy-first route dispatched
  // direct (user unticked useCorsProxy) must read 'direct'.
  const proxyFirst = { ...geminiRoute, transport: { bodyKind: 'json', initialDelivery: 'proxy' } };
  const stampedDirect = classifyOperation(proxyFirst, { references: [], delivery: 'direct' }, {});
  assert.equal(stampedDirect.delivery, 'direct');
});

test('classifyOperation honours the provider editDialect stamp over the connection', () => {
  // After the multipart→JSON proxy fallback the provider stamps what actually
  // went out (image-openai.js): editDialect 'json' + delivery 'proxy', even
  // though the connection still declares the conservative multipart default.
  const out = classifyOperation(baseRoute, { references: [{ id: 'r1' }], editDialect: 'json', delivery: 'proxy' }, {});
  assert.equal(out.operation, 'edit-json');
  assert.equal(out.referenceMode, 'json-data-url');
  assert.equal(out.delivery, 'proxy');
});

test('classifyOperation honours a multipart stamp over a json-declared connection', () => {
  const out = classifyOperation(baseRoute, { references: [{ id: 'r1' }], editDialect: 'multipart' }, { editProtocol: 'json' });
  assert.equal(out.operation, 'edit-multipart');
  assert.equal(out.referenceMode, 'multipart');
});

test('classifyOperation folds unknown contract into the neutral bucket', () => {
  const out = classifyOperation({ generationContract: 'weird', transport: {} }, { references: [] });
  assert.equal(out.operation, 'unknown');
  assert.equal(out.referenceMode, 'none');
  assert.equal(out.delivery, 'direct');
});

// ── classifyOutcome ─────────────────────────────────────────────────────────

const IMAGE_HTTP_ERROR = (code, message, status) => Object.assign(providerError(code, message), { httpStatus: status });

test('classifyOutcome success on no error', () => {
  assert.equal(classifyOutcome(null), 'success');
});

test('classifyOutcome timeout for Abort and Таймаут', () => {
  assert.equal(classifyOutcome(new DOMException('Aborted', 'AbortError')), 'timeout');
  const err = new Error('Таймаут (120с)');
  assert.equal(classifyOutcome(err), 'timeout');
});

test('classifyOutcome network-unknown for CORS TypeError and ambiguous delivery codes', () => {
  assert.equal(classifyOutcome(new TypeError('Failed to fetch')), 'network-unknown');
  assert.equal(classifyOutcome(providerError('IMAGE_DELIVERY_AMBIGUOUS', 'ambiguous')), 'network-unknown');
  assert.equal(classifyOutcome(providerError('MULTIPART_CORS_REQUIRED', 'multipart cors')), 'network-unknown');
});

test('classifyOutcome missing-image vs malformed via UPSTREAM_RESPONSE_INVALID', () => {
  assert.equal(classifyOutcome(providerError('UPSTREAM_RESPONSE_INVALID', 'returned a successful response without an image.')), 'missing-image');
  assert.equal(classifyOutcome(providerError('UPSTREAM_RESPONSE_INVALID', 'returned malformed JSON.')), 'malformed');
});

test('classifyOutcome auth for 401/403', () => {
  assert.equal(classifyOutcome(IMAGE_HTTP_ERROR('UPSTREAM_HTTP_ERROR', 'OpenAI returned HTTP 401: invalid', 401)), 'auth');
  assert.equal(classifyOutcome(IMAGE_HTTP_ERROR('UPSTREAM_HTTP_ERROR', 'HTTP 403', 403)), 'auth');
});

test('classifyOutcome quota for 402 or quota-flavoured 429', () => {
  assert.equal(classifyOutcome(IMAGE_HTTP_ERROR('UPSTREAM_HTTP_ERROR', 'insufficient_quota', 429)), 'quota');
  assert.equal(classifyOutcome(IMAGE_HTTP_ERROR('UPSTREAM_HTTP_ERROR', 'exhausted', 402)), 'quota');
});

test('classifyOutcome rate-limit for plain 429 without quota text', () => {
  assert.equal(classifyOutcome(IMAGE_HTTP_ERROR('UPSTREAM_HTTP_ERROR', 'Too many requests', 429)), 'rate-limit');
});

test('classifyOutcome provider-error for 5xx', () => {
  assert.equal(classifyOutcome(IMAGE_HTTP_ERROR('UPSTREAM_HTTP_ERROR', 'Bad gateway', 502)), 'provider-error');
});

test('classifyOutcome unsupported-feature for feature-dissent 400/404 messages', () => {
  assert.equal(classifyOutcome(IMAGE_HTTP_ERROR('UPSTREAM_HTTP_ERROR', 'Image editing is only supported for compatible providers', 400)), 'unsupported-feature');
  assert.equal(classifyOutcome(IMAGE_HTTP_ERROR('UPSTREAM_HTTP_ERROR', 'only imagen models are supported', 400)), 'unsupported-feature');
  assert.equal(classifyOutcome(IMAGE_HTTP_ERROR('UPSTREAM_HTTP_ERROR', 'maximum 1 image per request', 400)), 'unsupported-feature');
});

test('classifyOutcome content-policy for content/safety 400', () => {
  assert.equal(classifyOutcome(IMAGE_HTTP_ERROR('UPSTREAM_HTTP_ERROR', 'content policy violation', 400)), 'content-policy');
});

test('classifyOutcome invalid-request for feature-less 400 and invalid-request codes', () => {
  assert.equal(classifyOutcome(IMAGE_HTTP_ERROR('UPSTREAM_HTTP_ERROR', 'bad prompt', 400)), 'invalid-request');
  assert.equal(classifyOutcome(providerError('INVALID_REFERENCE', 'bad ref')), 'invalid-request');
  assert.equal(classifyOutcome(providerError('MISSING_API_KEY', 'no key')), 'invalid-request');
  assert.equal(classifyOutcome(providerError('TOO_MANY_REFERENCES', 'too many')), 'invalid-request');
});

test('classifyOutcome materialize for plain Error with no code/status', () => {
  assert.equal(classifyOutcome(new Error('storage failed')), 'materialize');
});

// ── formatObservationLog ─────────────────────────────────────────────────────

test('formatObservationLog success names the route, operation and accepted refs', () => {
  const attempt = { outcome: 'success', operation: 'edit-json', referenceMode: 'json-data-url', delivery: 'direct', refCount: 1 };
  const line = formatObservationLog(attempt, { modelId: 'gpt-image-1', contract: 'openai-images' });
  assert.match(line, /capability: route gpt-image-1 \/ openai-images \/ edit-json \/ direct -> confirmed/);
  assert.match(line, /1 ref accepted/);
});

test('formatObservationLog reports the evidence code on failure', () => {
  const attempt = { outcome: 'unsupported-feature', operation: 'edit-json', referenceMode: 'json-data-url', delivery: 'direct', refCount: 2, evidenceCode: 'UPSTREAM_HTTP_ERROR' };
  const line = formatObservationLog(attempt, { modelId: 'gpt-image-1', contract: 'openai-images' });
  assert.match(line, /-> unsupported-feature/);
  assert.match(line, /\[code UPSTREAM_HTTP_ERROR\]/);
  // Reference counts are only proven by a success; a rejection proves nothing.
  assert.ok(!/refs? accepted/.test(line));
});

test('formatObservationLog network-unknown never says unsupported', () => {
  const attempt = { outcome: 'network-unknown', operation: 'generate', referenceMode: 'none', delivery: 'direct', evidenceCode: 'IMAGE_DELIVERY_AMBIGUOUS' };
  const line = formatObservationLog(attempt, { modelId: 'gemini', contract: 'gemini-native' });
  assert.match(line, /-> network-unknown/);
  assert.match(line, /not reported as unsupported/);
  assert.ok(!/-> unsupported/.test(line));
});

test('formatObservationLog appends rid and connection editProtocol as trailing tokens, prefix intact', () => {
  const attempt = { outcome: 'success', operation: 'edit-multipart', referenceMode: 'multipart', delivery: 'direct', refCount: 2 };
  const line = formatObservationLog(attempt, { modelId: 'gpt-image-2', contract: 'openai-images', requestId: 'abcdef12-3456', editProtocol: 'json' });
  // Prefix must stay verbatim so panel greps and anchored tests keep matching.
  assert.match(line, /^capability: route gpt-image-2 \/ openai-images \/ edit-multipart \/ direct -> confirmed/);
  assert.match(line, /\[rid abcdef12\]/);
  // Persisted connection value, surfaced next to the inferred edit-* operation
  // so a card/persist drift (op says multipart, conn says json) is visible.
  assert.match(line, /\[conn json\]/);
});

test('formatObservationLog omits conn token for non-edit operations', () => {
  const attempt = { outcome: 'success', operation: 'generate', referenceMode: 'none', delivery: 'direct', refCount: 0 };
  const line = formatObservationLog(attempt, { modelId: 'gpt-image-2', contract: 'openai-images', requestId: 'abcdef12', editProtocol: 'json' });
  assert.ok(!/\[conn /.test(line));
  assert.match(line, /\[rid abcdef12\]/);
});

// ── observeCapabilityAttempt: classify + log, persist nothing ────────────────

test('observeCapabilityAttempt classifies a successful attempt', () => {
  const attempt = observeCapabilityAttempt({
    route: baseRoute, request: { references: [] }, httpStatus: 200, error: null,
  });
  assert.equal(attempt?.outcome, 'success');
  assert.equal(attempt?.operation, 'generate');
  assert.equal(attempt?.referenceMode, 'none');
});

test('observeCapabilityAttempt uses the connection editProtocol for the edit dialect', () => {
  const asJson = observeCapabilityAttempt({
    route: baseRoute, request: { references: [{ id: 'r1' }] },
    connection: { editProtocol: 'json' }, httpStatus: 200,
  });
  assert.equal(asJson?.operation, 'edit-json');
  const asMultipart = observeCapabilityAttempt({
    route: baseRoute, request: { references: [{ id: 'r1' }] },
    connection: {}, httpStatus: 200,
  });
  assert.equal(asMultipart?.operation, 'edit-multipart');
});

test('observeCapabilityAttempt logs the fallback truth (edit-json / proxy) with the conn token showing the card value', () => {
  // Successful multipart→JSON proxy fallback: the request carries provider
  // stamps, so the line reports the real attempt while the [conn multipart]
  // token still surfaces the persisted connection value for comparison.
  const seen = [];
  const attempt = observeCapabilityAttempt({
    route: baseRoute,
    request: { references: [{ id: 'r1' }], editDialect: 'json', delivery: 'proxy' },
    connection: { editProtocol: 'multipart' }, httpStatus: 200,
    notify: line => seen.push(line),
  });
  assert.equal(attempt?.operation, 'edit-json');
  assert.equal(attempt?.referenceMode, 'json-data-url');
  assert.equal(attempt?.delivery, 'proxy');
  assert.equal(attempt?.outcome, 'success');
  assert.match(seen[0], /^capability: route gpt-image-1 \/ openai-images \/ edit-json \/ proxy -> confirmed/);
  assert.match(seen[0], /\[conn multipart\]/);
});

test('observeCapabilityAttempt never throws on pathological input', () => {
  assert.equal(observeCapabilityAttempt({ route: null, request: null }), null);
  assert.equal(observeCapabilityAttempt(), null);
  // Unknown contract folds to the neutral bucket and is not logged.
  assert.equal(observeCapabilityAttempt({ route: { generationContract: 'nope' }, request: {} }), null);
});

test('observeCapabilityAttempt forwards the log line to the notify hook and survives a throwing hook', () => {
  const seen = [];
  observeCapabilityAttempt({
    route: baseRoute, request: { references: [] }, httpStatus: 200,
    notify: line => seen.push(line),
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^capability: route gpt-image-1/);

  const attempt = observeCapabilityAttempt({
    route: baseRoute, request: { references: [] }, httpStatus: 200,
    notify: () => { throw new Error('UI hook exploded'); },
  });
  assert.equal(attempt?.outcome, 'success');
});