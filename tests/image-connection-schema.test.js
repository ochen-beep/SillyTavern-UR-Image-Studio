// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTRACTS,
  CAPABILITY_STATES,
  CONNECTION_TIMEOUT_DEFAULT_MS,
  CONNECTION_TIMEOUT_MIN_MS,
  CONNECTION_TIMEOUT_MAX_MS,
  normalizeConnectionTimeoutMs,
  normalizeConnectionRecord,
  normalizeRouteContract,
  deriveStableRouteId,
  stripSecrets,
} from '../src/image-connection-schema.js';
import {
  IMAGE_CONNECTION_SETTINGS_KEY,
  defaultImageConnectionSettings,
  getImageConnectionSettings,
  getImageConnectionKeyNamespace,
} from '../src/core.js';

test('normalizes connection timeouts to the supported safe range', () => {
  assert.equal(CONNECTION_TIMEOUT_DEFAULT_MS, 120000);
  assert.equal(CONNECTION_TIMEOUT_MIN_MS, 15000);
  assert.equal(CONNECTION_TIMEOUT_MAX_MS, 600000);
  assert.equal(normalizeConnectionTimeoutMs(), CONNECTION_TIMEOUT_DEFAULT_MS);
  assert.equal(normalizeConnectionTimeoutMs(CONNECTION_TIMEOUT_MIN_MS), CONNECTION_TIMEOUT_MIN_MS);
  assert.equal(normalizeConnectionTimeoutMs(CONNECTION_TIMEOUT_MAX_MS), CONNECTION_TIMEOUT_MAX_MS);

  for (const timeoutMs of ['120000', 15000.5, NaN, 14999, 600001]) {
    assert.throws(() => normalizeConnectionTimeoutMs(timeoutMs), /timeoutMs.*safe integer.*15000.*600000/i);
  }
});

test('normalizes bounded Chat Completions image config override', () => {
  const record = normalizeConnectionRecord({
    overrides: { chatCompletionsImageConfig: ' openrouter ' },
  });
  assert.equal(record.overrides.chatCompletionsImageConfig, 'openrouter');
  assert.equal(normalizeConnectionRecord({ overrides: { chatCompletionsImageConfig: 'new-api' } }).overrides.chatCompletionsImageConfig, 'new-api');
  assert.equal(normalizeConnectionRecord({ overrides: { chatCompletionsImageConfig: 'unknown' } }).overrides.chatCompletionsImageConfig, undefined);
});

test('normalizes connection record timeout metadata without retaining secrets', () => {
  const record = normalizeConnectionRecord({ timeoutMs: 300000, apiKey: 'must-not-survive' });
  assert.equal(record.timeoutMs, 300000);
  assert.equal(record.apiKey, undefined);
  assert.equal(normalizeConnectionRecord({}).timeoutMs, CONNECTION_TIMEOUT_DEFAULT_MS);
});

test('normalizes routes with generationContract and no legacy contract output', () => {
  const route = normalizeRouteContract({
    source: 'openai-models', modelId: 'gpt-image-1', apiFamily: 'openai-images',
    capabilities: { generate: 'supported', references: 'unsupported', edit: 'unknown' },
    bodyKind: 'json', proxyEligible: true, directCors: 'preferred',
  });
  assert.equal(route.contractVersion, 1);
  assert.equal(route.generationContract, CONTRACTS.OPENAI_IMAGES);
  assert.equal('contract' in route, false);
  assert.deepEqual(route.capabilities, { generate: 'supported', references: 'unsupported', edit: 'unknown' });
  assert.equal(route.transport.bodyKind, 'json');
  // proxyEligible ушёл из транспортных метаданных (2026-09-28): эскалация
  // доставки гейтится оракулом, а не флагом; устаревшее поле вырезается.
  assert.equal('proxyEligible' in route.transport, false);
  assert.equal(route.transport.directCors, 'preferred');
  assert.match(route.id, /^route_[a-f0-9]{24}$/);
});

test('normalizes structured route capability metadata for adapters and UI', () => {
  const route = normalizeRouteContract({
    generationContract: 'openrouter-images', source: 'openrouter-models', modelId: 'image-model',
    capabilities: {
      generate: 'supported', references: 'supported', edit: 'unknown', maxReferences: 3,
      supportedParameters: ['aspect_ratio', 'input_references'],
      aspectRatios: ['1:1', '16:9'], imageSizes: ['1K', '2K'], qualityValues: ['standard', 'high'],
      providerTag: 'safe-provider',
    },
  });

  assert.deepEqual(route.capabilities, {
    generate: 'supported', references: 'supported', edit: 'unknown', maxReferences: 3,
    supportedParameters: ['aspect_ratio', 'input_references'],
    aspectRatios: ['1:1', '16:9'], imageSizes: ['1K', '2K'], qualityValues: ['standard', 'high'],
    providerTag: 'safe-provider',
  });
});

test('trims canonical route strings and retains known null capability metadata as unknown', () => {
  const route = normalizeRouteContract({
    generationContract: ' openrouter-images ', source: ' openrouter-models ', modelId: ' image-model ',
    capabilities: {
      supportedParameters: [' aspect_ratio ', 'quality '], maxReferences: null,
      aspectRatios: null, imageSizes: null, qualityValues: null,
    },
    remoteMetadata: { providerTag: ' fal ', providerName: ' FAL ', supportedParameters: null },
  });

  assert.equal(route.source, 'openrouter-models');
  assert.equal(route.modelId, 'image-model');
  assert.deepEqual(route.capabilities, {
    supportedParameters: ['aspect_ratio', 'quality'], maxReferences: null,
    aspectRatios: null, imageSizes: null, qualityValues: null,
    generate: 'unknown', references: 'unknown', edit: 'unknown',
  });
  assert.deepEqual(route.remoteMetadata, { providerTag: 'fal', providerName: 'FAL', supportedParameters: null });
});

test('bounds numeric reference capability and rejects unsafe structured metadata', () => {
  const route = normalizeRouteContract({
    generationContract: 'openai-images', source: 'openai-models', modelId: 'image-model',
    capabilities: { maxReferences: 999 },
  });
  assert.equal(route.capabilities.maxReferences, 64);
  for (const capabilities of [
    { maxReferences: -1 },
    { maxReferences: '3' },
    { supportedParameters: ['safe', 1] },
    { supportedParameters: ['   '] },
    { apiKey: 'secret' },
    { 'private-key': 'secret' },
    { unsafe: { nested: true } },
    { unknown: null },
  ]) {
    assert.throws(() => normalizeRouteContract({ generationContract: 'openai-images', modelId: 'image-model', capabilities }), /capabilit|metadata|secret/i);
  }
});

test('validates remote metadata with a bounded contract-specific schema', () => {
  const gemini = normalizeRouteContract({
    generationContract: 'gemini-native', modelId: 'imagen',
    remoteMetadata: { versionedBase: ' https://gateway.example/v1 ', authStrategy: ' bearer ', geminiApiVersion: ' v1 ' },
  });
  assert.deepEqual(gemini.remoteMetadata, {
    versionedBase: 'https://gateway.example/v1', authStrategy: 'bearer', geminiApiVersion: 'v1',
  });

  for (const remoteMetadata of [
    { token: 'secret' }, { arbitrary: null }, { providerTag: { nested: true } },
    { providerTag: '   ' }, { supportedParameters: ['safe', '  '] },
  ]) {
    assert.throws(() => normalizeRouteContract({
      generationContract: 'openrouter-images', modelId: 'image-model', remoteMetadata,
    }), /metadata|secret/i);
  }
});

test('rejects secret-shaped remote metadata before secret stripping in connection records', () => {
  assert.throws(() => normalizeConnectionRecord({
    selectedRoute: { generationContract: 'openrouter-images', modelId: 'image-model', remoteMetadata: { apiKey: 'secret' } },
  }), /metadata|secret/i);
});

test('only migrates omitted contract versions and rejects supplied invalid versions', () => {
  assert.equal(normalizeRouteContract({ generationContract: 'openai-images', modelId: 'image-model' }).contractVersion, 1);
  assert.equal(normalizeConnectionRecord({ endpoint: ' https://example.test/ ' }).contractVersion, 1);
  for (const contractVersion of [null, '1', 1.1, 2]) {
    assert.throws(() => normalizeRouteContract({ generationContract: 'openai-images', modelId: 'image-model', contractVersion }), /contract version/i);
    assert.throws(() => normalizeConnectionRecord({ contractVersion }), /contract version/i);
  }
});

test('enforces multipart transport invariants', () => {
  const route = normalizeRouteContract({ generationContract: 'gemini-native', source: 'gemini', modelId: 'imagen', bodyKind: 'multipart', directCors: 'required' });
  assert.equal('proxyEligible' in route.transport, false);
  assert.throws(() => normalizeRouteContract({ generationContract: 'gemini-native', source: 'gemini', modelId: 'imagen', bodyKind: 'multipart', directCors: 'preferred' }), /multipart/i);
  // proxyEligible больше не валидируется — multipart-инвариант только в directCors.
  assert.doesNotThrow(() => normalizeRouteContract({ generationContract: 'gemini-native', source: 'gemini', modelId: 'imagen', bodyKind: 'multipart', proxyEligible: true, directCors: 'required' }));
  assert.throws(() => normalizeRouteContract({ generationContract: 'gemini-native', source: 'gemini', modelId: 'imagen', bodyKind: 'multipart', directCors: 'preferred' }), /multipart/i);
});
test('rejects unknown or executable contracts and invalid capability or transport values', () => {
  assert.throws(() => normalizeRouteContract({ contract: 'javascript:alert(1)', modelId: 'x' }), /contract/i);
  assert.throws(() => normalizeRouteContract({ contract: 'vendor-custom', modelId: 'x' }), /contract/i);
  assert.throws(() => normalizeRouteContract({ contract: 'openai-images', modelId: 'x', capabilities: { generate: 'yes' } }), /capabilit/i);
  assert.throws(() => normalizeRouteContract({ contract: 'openai-images', modelId: 'x', bodyKind: 'text' }), /bodyKind/i);
});

test('derives stable ids from source, model, and contract', () => {
  const a = deriveStableRouteId('openai-models', 'gpt-image-1', 'openai-images');
  const b = deriveStableRouteId('openai-models', 'gpt-image-1', 'openai-images');
  assert.equal(a, b);
  assert.notEqual(a, deriveStableRouteId('manual', 'gpt-image-1', 'openai-images'));
  assert.match(a, /^route_[a-f0-9]{24}$/);
});

test('replaces supplied route ids with the canonical identity id', () => {
  const route = normalizeRouteContract({
    id: 'forged-route-id', source: ' openai-models ', modelId: ' gpt-image-1 ', generationContract: 'openai-images',
  });
  assert.equal(route.id, deriveStableRouteId('openai-models', 'gpt-image-1', 'openai-images'));
  assert.notEqual(route.id, 'forged-route-id');
});

test('strips expanded secret fields recursively without changing non-secret data', () => {
  const value = {
    name: 'x', apiKey: 'top', api_token: 'token', 'api-token': 'hyphen-token', 'API TOKEN': 'spaced-token',
    authorization: 'Bearer auth', accessToken: 'access', refreshToken: 'refresh', privateKey: 'private',
    bearerToken: 'bearer', clientSecret: 'client',
    nested: { token: 't', refresh_token: 'nested-refresh', private_key: 'nested-private', keep: 2, list: [{ password: 'p', ok: true }] },
    connection: { credentials: { authorization: 'Bearer nested', accessToken: 'nested-access', refreshToken: 'nested-refresh', privateKey: 'nested-private', clientSecret: 'nested-client' }, keep: 'connection-value' },
    secretId: 'id',
  };
  assert.deepEqual(stripSecrets(value), {
    name: 'x', nested: { keep: 2, list: [{ ok: true }] },
    connection: { credentials: {}, keep: 'connection-value' },
  });
});

test('strips header-style API key and token aliases without removing ordinary prose fields', () => {
  const value = {
    'x-api-key': 'key',
    'X_API_TOKEN': 'token',
    'x api key': 'spaced-key',
    'X-Api-Token': 'mixed-token',
    nested: { 'x_api_key': 'nested-key', keep: true },
    apiKeyInstructions: 'Use the API key header.',
    tokenCount: 42,
    secretSauce: 'ordinary prose',
  };

  assert.deepEqual(stripSecrets(value), {
    nested: { keep: true },
    apiKeyInstructions: 'Use the API key header.',
    tokenCount: 42,
    secretSauce: 'ordinary prose',
  });
});

test('strips Google API key header aliases recursively without removing ordinary prose fields', () => {
  const value = {
    'x-goog-api-key': 'key',
    'X_GOOG_API_KEY': 'underscore-key',
    'X Goog Api Key': 'spaced-key',
    nested: { 'xGoogApiKey': 'nested-key', keep: true },
    googleApiKeyInstructions: 'Use the Google API key header.',
  };

  assert.deepEqual(stripSecrets(value), {
    nested: { keep: true },
    googleApiKeyInstructions: 'Use the Google API key header.',
  });
});

test('migrates selectedRoute and apiFamily records conservatively', () => {
  const record = normalizeConnectionRecord({
    id: 'conn-1', name: 'Primary', endpoint: 'https://example.test/v1',
    apiFamily: 'gemini-native',
    selectedRoute: { source: 'gemini-models', modelId: 'imagen-3', apiFamily: 'gemini-native' },
    apiKey: 'must-not-survive', metadata: { secret: 'nope' },
  });
  assert.equal(record.contractVersion, 1);
  assert.equal(record.selectedRoute.generationContract, 'gemini-native');
  assert.equal(record.selectedRoute.apiFamily, 'gemini-native');
  assert.equal('contract' in record.selectedRoute, false);
  assert.equal(record.apiFamily, 'gemini-native');
  assert.equal(record.apiKey, undefined);
  assert.equal(record.metadata.secret, undefined);
});

test('uses the canonical selected route ID when persisted route IDs disagree', () => {
  const record = normalizeConnectionRecord({
    selectedRouteId: 'stale-route-id',
    selectedRoute: { id: 'normalized-route-id', source: 'openai', modelId: 'gpt-image-1', apiFamily: 'openai-images' },
  });
  const canonical = deriveStableRouteId('openai', 'gpt-image-1', 'openai-images');
  assert.equal(record.selectedRoute.id, canonical);
  assert.equal(record.selectedRouteId, canonical);
});

test('preserves a legacy auto route without a generation contract as unresolved', () => {
  const record = normalizeConnectionRecord({
    apiFamilyOverride: 'auto',
    selectedRouteId: 'legacy-route-id',
    selectedRoute: { id: 'legacy-route-id', source: 'legacy-catalog', modelId: 'legacy-image-model' },
  });

  assert.equal(record.apiFamily, null);
  assert.equal(record.selectedRouteId, 'legacy-route-id');
  assert.deepEqual(record.selectedRoute, {
    id: 'legacy-route-id',
    source: 'legacy-catalog',
    modelId: 'legacy-image-model',
    resolutionState: 'unresolved',
  });
});

test('preserves bounded catalog diagnostics and normalized capability metadata', () => {
  const record = normalizeConnectionRecord({
    detected: {
      apiShape: 'openai', auth: 'bearer', delivery: 'direct',
      modelIds: ['nai-diffusion'],
      modelMetadata: [{
        modelId: 'nai-diffusion', mediaKind: 'image', imageGeneration: true,
        references: 'supported', maxReferences: 5, imageSizes: ['1024x1024'],
        source: 'nanogpt-image-models', provider: 'nanogpt',
      }],
      catalogSource: 'nanogpt-image-models',
      catalogUrl: 'https://nano-gpt.com/api/v1/images/models',
      metadataCount: 1,
      partial: true,
    },
  });
  assert.equal(record.detected.catalogSource, 'nanogpt-image-models');
  assert.equal(record.detected.catalogUrl, 'https://nano-gpt.com/api/v1/images/models');
  assert.equal(record.detected.metadataCount, 1);
  assert.equal(record.detected.partial, true);
  assert.equal(record.detected.modelMetadata[0].maxReferences, 5);
  assert.deepEqual(record.detected.modelMetadata[0].imageSizes, ['1024x1024']);
});

test('provides shared image connection settings defaults and namespaced key helpers', () => {
  assert.equal(IMAGE_CONNECTION_SETTINGS_KEY, 'imageConnections');
  assert.deepEqual(defaultImageConnectionSettings, {
    schemaVersion: 1, connections: [], catalogs: {}, galleryIndex: [], templates: [], presets: [], refs: [], folders: [], selectedRouteId: null,
  });
  const settings = { selectedRouteId: 'r1', apiKey: 'no-store' };
  assert.equal(getImageConnectionSettings({ imageConnections: settings }).selectedRouteId, 'r1');
  assert.equal(getImageConnectionSettings({}).selectedRouteId, null);
  assert.equal(getImageConnectionSettings({ imageConnections: settings }).apiKey, undefined);
  assert.equal(getImageConnectionKeyNamespace('conn-1'), 'uris_api_key:conn-1');
});

assert.deepEqual([...CAPABILITY_STATES], ['supported', 'unsupported', 'unknown']);

// ── capabilityObservations: dropped legacy field ──────────────────────────────
//
// Observations used to be persisted per route. The observer is diagnostic-only
// now (see capability-observer.js), so normalization drops the field instead of
// carrying it forward — otherwise stale maps would linger in extension settings
// forever and act as an invisible second source of truth about the route.

test('normalizeRouteContract drops a legacy capabilityObservations map', () => {
  const route = normalizeRouteContract({
    source: 'openai-models', modelId: 'gpt-image-1', apiFamily: 'openai-images',
    bodyKind: 'json', proxyEligible: true, directCors: 'preferred',
    capabilityObservations: {
      'edit-multipart|multipart': { outcome: 'success', observedAt: '2026-08-02T12:00:00.000Z' },
    },
  });
  assert.equal('capabilityObservations' in route, false);
});

test('normalizeRouteContract accepts a malformed legacy capabilityObservations value without throwing', () => {
  // Previously this threw TypeError. A field nothing reads must not be able to
  // brick a connection record on load.
  const route = normalizeRouteContract({
    source: 'openai-models', modelId: 'gpt-image-1', apiFamily: 'openai-images',
    capabilityObservations: 'not-an-object',
  });
  assert.equal('capabilityObservations' in route, false);
});
