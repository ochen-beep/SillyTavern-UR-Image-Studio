import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BRIDGE_API_VERSION,
    UrisBridgeError,
    bridgeError,
    normalizeBridgeRequest,
    validateBridgeCaller,
    activateBridge,
    deactivateBridge,
    getBridge,
    markBridgeFailed,
    markBridgeReady,
    bridgeCallerFromRequestId,
    classifyBridgeError,
    sanitizeBridgeCard,
    sanitizeBridgePendingRecord,
    normalizeGalleryQuery,
} from '../src/bridge.js';

function assertBridgeError(fn, code) {
    try {
        fn();
    } catch (e) {
        assert.ok(e instanceof UrisBridgeError, `expected UrisBridgeError, got ${e?.name}: ${e?.message}`);
        assert.equal(e.code, code);
        return;
    }
    assert.fail(`expected UrisBridgeError (${code}) but nothing was thrown`);
}

test('bridge: api version constant is exported', () => {
    assert.equal(typeof BRIDGE_API_VERSION, 'number');
    assert.ok(BRIDGE_API_VERSION >= 1);
});

test('bridge: caller validation', () => {
    assert.equal(validateBridgeCaller('offstage'), 'offstage');
    assert.equal(validateBridgeCaller('my-phone_ui-2'), 'my-phone_ui-2');
    assertBridgeError(() => validateBridgeCaller(undefined), 'INVALID_CALLER');
    assertBridgeError(() => validateBridgeCaller(''), 'INVALID_CALLER');
    assertBridgeError(() => validateBridgeCaller('_leading'), 'INVALID_CALLER');
    assertBridgeError(() => validateBridgeCaller('has space'), 'INVALID_CALLER');
    assertBridgeError(() => validateBridgeCaller('x'.repeat(65)), 'INVALID_CALLER');
});

test('bridge: request normalization applies defaults', () => {
    const norm = normalizeBridgeRequest({ prompt: '  a cat  ' });
    assert.deepEqual(norm, {
        prompt: 'a cat',
        aspectRatio: '1:1',
        imageSize: '1K',
        quality: 'auto',
        references: [],
        connectionId: null,
        modelId: null,
        trigger: null,
        useSceneRefs: false,
        expandMacros: true,
    });
});

test('bridge: pool references carry refId without a payload', () => {
    const norm = normalizeBridgeRequest({
        prompt: 'p',
        references: [{ refId: '  ref-1 ' }, { refId: 'ref-2' }],
        useSceneRefs: true,
    });
    assert.deepEqual(norm.references, [
        { refId: 'ref-1', id: '', name: '', dataUrl: '' },
        { refId: 'ref-2', id: '', name: '', dataUrl: '' },
    ]);
    assert.equal(norm.useSceneRefs, true);
    // Пустой refId не спасает от валидации dataUrl.
    assertBridgeError(() => normalizeBridgeRequest({ prompt: 'p', references: [{ refId: '  ' }] }), 'INVALID_PARAMS');
    // expandMacros можно выключить.
    assert.equal(normalizeBridgeRequest({ prompt: 'p', expandMacros: false }).expandMacros, false);
});

test('bridge: request normalization accepts full payload', () => {
    const norm = normalizeBridgeRequest({
        prompt: 'p',
        aspectRatio: '9:16',
        imageSize: '2K',
        quality: 'high',
        references: [{ dataUrl: 'data:image/png;base64,AAAA', name: 'alice' }],
        connectionId: ' conn-1 ',
        modelId: 'model-x',
    });
    assert.equal(norm.aspectRatio, '9:16');
    assert.equal(norm.imageSize, '2K');
    assert.equal(norm.quality, 'high');
    assert.deepEqual(norm.references, [{ refId: '', id: '', name: 'alice', dataUrl: 'data:image/png;base64,AAAA' }]);
    assert.equal(norm.connectionId, 'conn-1');
    assert.equal(norm.modelId, 'model-x');
});

test('bridge: invalid params produce coded errors', () => {
    assertBridgeError(() => normalizeBridgeRequest(null), 'INVALID_PARAMS');
    assertBridgeError(() => normalizeBridgeRequest('prompt'), 'INVALID_PARAMS');
    assertBridgeError(() => normalizeBridgeRequest({}), 'INVALID_PARAMS');
    assertBridgeError(() => normalizeBridgeRequest({ prompt: '   ' }), 'INVALID_PARAMS');
    assertBridgeError(() => normalizeBridgeRequest({ prompt: 'x', aspectRatio: '7:3' }), 'INVALID_PARAMS');
    assertBridgeError(() => normalizeBridgeRequest({ prompt: 'x', imageSize: '8K' }), 'INVALID_PARAMS');
    assertBridgeError(() => normalizeBridgeRequest({ prompt: 'x', quality: 'ultra' }), 'INVALID_PARAMS');
    assertBridgeError(() => normalizeBridgeRequest({ prompt: 'x', references: 'no' }), 'INVALID_PARAMS');
    assertBridgeError(() => normalizeBridgeRequest({ prompt: 'x', references: [{ dataUrl: 'javascript:alert(1)' }] }), 'INVALID_PARAMS');
    assertBridgeError(() => normalizeBridgeRequest({ prompt: 'x', references: [{}] }), 'INVALID_PARAMS');
    assertBridgeError(() => normalizeBridgeRequest({ prompt: 'x', references: new Array(9).fill({ dataUrl: 'data:image/png;base64,AA' }) }), 'INVALID_PARAMS');
});

test('bridge: http(s) reference URLs are accepted', () => {
    const norm = normalizeBridgeRequest({ prompt: 'p', references: [{ dataUrl: 'https://example.com/a.png' }] });
    assert.equal(norm.references[0].dataUrl, 'https://example.com/a.png');
});

test('bridge: bridgeError builds coded UrisBridgeError', () => {
    const err = bridgeError('NO_CONNECTION', 'msg');
    assert.ok(err instanceof Error);
    assert.equal(err.code, 'NO_CONNECTION');
    assert.equal(err.name, 'UrisBridgeError');
});

test('bridge: activation publishes global and deactivate removes it', () => {
    const bridge = activateBridge();
    assert.ok(bridge);
    assert.equal(globalThis.URIS, bridge);
    assert.equal(typeof bridge.generate, 'function');
    assert.equal(typeof bridge.abort, 'function');
    assert.equal(typeof bridge.getStatus, 'function');
    assert.equal(typeof bridge.listConnections, 'function');
    assert.equal(typeof bridge.on, 'function');
    assert.equal(bridge.apiVersion, BRIDGE_API_VERSION);
    assert.ok(typeof bridge.ready?.then === 'function');

    // Frozen surface: consumers cannot monkey-patch the API unnoticed.
    assert.throws(() => { 'use strict'; globalThis.URIS.generate = () => {}; });

    markBridgeReady();
    deactivateBridge();
    assert.equal(globalThis.URIS, undefined);
    assert.equal(getBridge(), null);
});

test('bridge: buildPrompt surface rejects with structured codes (no ST needed)', async () => {
    const { state } = await import('../src/core.js');
    const savedSettings = state.settings;
    const bridge = activateBridge();
    try {
        // Валидация caller идёт ДО гейта: без caller — INVALID_CALLER даже при выключенном мосте.
        await assert.rejects(
            () => bridge.buildPrompt({ text: 'x' }, {}),
            e => e instanceof UrisBridgeError && e.code === 'INVALID_CALLER',
        );
        // Мост активен, но state.settings.enabled !== true (node) — EXT_DISABLED.
        await assert.rejects(
            () => bridge.buildPrompt({ text: 'x' }, { caller: 'lab' }),
            e => e instanceof UrisBridgeError && e.code === 'EXT_DISABLED',
        );
        // Гейт пройден (фейковые настройки) — пустой текст ловит валидация.
        state.settings = { enabled: true, bridgeEnabled: true };
        await assert.rejects(
            () => bridge.buildPrompt({}, { caller: 'lab' }),
            e => e instanceof UrisBridgeError && e.code === 'INVALID_PARAMS',
        );
    } finally {
        state.settings = savedSettings;
        deactivateBridge();
        assert.equal(globalThis.URIS, undefined);
    }
});

test('bridge: activate is idempotent', () => {
    const first = activateBridge();
    const second = activateBridge();
    assert.equal(first, second);
    deactivateBridge();
    assert.equal(globalThis.URIS, undefined);
});

test('bridge: parseInline resolves profiles via trigger registry', async () => {
    const bridge = activateBridge();
    try {
        const markers = bridge.parseInline('смотри [[селфи: на пляже]] и [[img: чашка]]');
        assert.equal(markers.length, 2);
        assert.equal(markers[0].type, 'селфи');
        assert.equal(markers[0].profile?.id, 'selfie');
        assert.equal(markers[0].profile?.aspect, '9:16');
        assert.equal(markers[1].profile?.id, 'img');
        // неизвестный тип → profile null (хост решает: img-fallback или скрыть)
        const unknown = bridge.parseInline('[[бред: x]]');
        assert.equal(unknown[0].profile, null);
    } finally { deactivateBridge(); }
});

test('bridge: generate with unknown trigger → TRIGGER_NOT_FOUND', async () => {
    const { state } = await import('../src/core.js');
    const savedSettings = state.settings;
    const bridge = activateBridge();
    try {
        // В node нет ни настроек, ни дефолтного коннекта чата: включаем мост
        // и задаём connectionId явно, чтобы дойти до резолва триггера.
        state.settings = { enabled: true, bridgeEnabled: true };
        await assert.rejects(
            () => bridge.generate({ trigger: 'несуществует', prompt: 'x', connectionId: 'conn-x' }, { caller: 'lab' }),
            e => e instanceof UrisBridgeError && e.code === 'TRIGGER_NOT_FOUND',
        );
    } finally {
        state.settings = savedSettings;
        deactivateBridge();
        assert.equal(globalThis.URIS, undefined);
    }
});

test('bridge: generate trigger lookup is case/ё-insensitive (symmetric with parseInline)', async () => {
    const { state } = await import('../src/core.js');
    const savedSettings = state.settings;
    const bridge = activateBridge();
    try {
        state.settings = { enabled: true, bridgeEnabled: true };
        // Триггер матчится по id (не по алиасу), но без учёта регистра:
        // 'SELFIE' резолвится в профиль selfie → ошибка уже НЕ про триггер
        // (дальше конвейер падает на отсутствии соединения).
        await assert.rejects(
            () => bridge.generate({ trigger: 'SELFIE', prompt: 'x', connectionId: 'conn-x' }, { caller: 'lab' }),
            e => !(e instanceof UrisBridgeError && e.code === 'TRIGGER_NOT_FOUND'),
        );
        // Ё/е и регистр симметричны с parseInline: 'ЁЖИК' → id 'ежик'.
        state.settings = { enabled: true, bridgeEnabled: true, inlineTriggers: [{ id: 'ёжик', aliases: ['ёжик'] }] };
        await assert.rejects(
            () => bridge.generate({ trigger: 'ЁЖИК', prompt: 'x', connectionId: 'conn-x' }, { caller: 'lab' }),
            e => !(e instanceof UrisBridgeError && e.code === 'TRIGGER_NOT_FOUND'),
        );
    } finally {
        state.settings = savedSettings;
        deactivateBridge();
        assert.equal(globalThis.URIS, undefined);
    }
});

test('bridge: unknown connectionId → coded NO_CONNECTION (never a bare Error)', async () => {
    const { state } = await import('../src/core.js');
    const savedSettings = state.settings;
    const savedST = globalThis.SillyTavern;
    const bridge = activateBridge();
    try {
        state.settings = { enabled: true, bridgeEnabled: true };
        // Минимальный ST-стаб: пустое хранилище соединений → resolveConnection null.
        globalThis.SillyTavern = { getContext: () => ({ extensionSettings: {} }) };
        await assert.rejects(
            () => bridge.generate({ prompt: 'x', connectionId: 'nope-404' }, { caller: 'lab' }),
            e => e instanceof UrisBridgeError && e.code === 'NO_CONNECTION',
        );
        // Соединение не резолвится и при modelId — NO_ROUTE не должен маскировать
        // отсутствие соединения другим кодом.
        await assert.rejects(
            () => bridge.generate({ prompt: 'x', connectionId: 'nope-404', modelId: 'm' }, { caller: 'lab' }),
            e => e instanceof UrisBridgeError && e.code === 'NO_CONNECTION',
        );
    } finally {
        state.settings = savedSettings;
        if (savedST === undefined) delete globalThis.SillyTavern; else globalThis.SillyTavern = savedST;
        deactivateBridge();
    }
});

test('bridge: failed init rejects URIS.ready instead of hanging', async () => {
    const bridge = activateBridge();
    // Слушатель вешается ДО отказа: потребители из брифа делают await URIS.ready.
    const settled = assert.rejects(
        () => bridge.ready,
        e => e instanceof Error,
    );
    markBridgeFailed(new Error('boom'));
    await settled;
    deactivateBridge();
    assert.equal(globalThis.URIS, undefined);
});

test('bridge: deactivate rejects a pending ready promise', async () => {
    const bridge = activateBridge();
    const settled = assert.rejects(
        () => bridge.ready,
        e => e instanceof UrisBridgeError && e.code === 'NOT_READY',
    );
    deactivateBridge();
    await settled;
    assert.equal(globalThis.URIS, undefined);
});

// ── Attribution, classification and sanitizers (v0.9.6 surface) ──

test('bridge: bridgeCallerFromRequestId parses ext ids', () => {
    assert.equal(bridgeCallerFromRequestId('ext_offstage_123e4567-e89b-12d3-a456-426614174000'), 'offstage');
    // caller may itself contain underscores — the uuid never does.
    assert.equal(bridgeCallerFromRequestId('ext_my_phone_app_abc123'), 'my_phone_app');
    // Manual (non-bridge) request ids never parse to a caller.
    assert.equal(bridgeCallerFromRequestId('manual_123'), null);
    assert.equal(bridgeCallerFromRequestId('gen_abc_def'), null);
    // Garbage and non-strings are null, never throws.
    assert.equal(bridgeCallerFromRequestId(null), null);
    assert.equal(bridgeCallerFromRequestId(undefined), null);
    assert.equal(bridgeCallerFromRequestId(42), null);
    assert.equal(bridgeCallerFromRequestId(''), null);
    assert.equal(bridgeCallerFromRequestId('ext_'), null);
    assert.equal(bridgeCallerFromRequestId('ext_offstage_'), null);
    // The captured piece must be a valid caller tag.
    assert.equal(bridgeCallerFromRequestId('ext_bad caller_uuid'), null);
    assert.equal(bridgeCallerFromRequestId(`ext_${'x'.repeat(65)}_uuid`), null);
});

test('bridge: classifyBridgeError — bridge-owned codes', () => {
    assert.deepEqual(classifyBridgeError(bridgeError('ABORTED', 'x')), { code: 'ABORTED', category: 'cancelled', retryable: false });
    assert.deepEqual(classifyBridgeError(bridgeError('NOT_READY', 'x')), { code: 'NOT_READY', category: 'unavailable', retryable: true });
    assert.deepEqual(classifyBridgeError(bridgeError('EXT_DISABLED', 'x')), { code: 'EXT_DISABLED', category: 'unavailable', retryable: true });
    assert.deepEqual(classifyBridgeError(bridgeError('INVALID_PARAMS', 'x')), { code: 'INVALID_PARAMS', category: 'invalid-request', retryable: false });
    assert.deepEqual(classifyBridgeError(bridgeError('INVALID_CALLER', 'x')), { code: 'INVALID_CALLER', category: 'invalid-request', retryable: false });
    assert.deepEqual(classifyBridgeError(bridgeError('CARD_NOT_OWNED', 'x')), { code: 'CARD_NOT_OWNED', category: 'invalid-request', retryable: false });
    for (const code of ['NO_CONNECTION', 'NO_ROUTE', 'TRIGGER_NOT_FOUND', 'REF_NOT_FOUND', 'REF_UNAVAILABLE', 'NOT_FOUND', 'TEMPLATE_INVALID', 'MISSING_API_KEY', 'POLLINATIONS_TOKEN_REQUIRED', 'NAISTERA_TOKEN_INVALID']) {
        assert.deepEqual(classifyBridgeError(bridgeError(code, 'x')), { code, category: 'config', retryable: false }, `${code} must classify as config`);
    }
    // Raw AbortError (as thrown by fetch) classifies as cancelled too.
    const domAbort = new Error('aborted');
    domAbort.name = 'AbortError';
    assert.deepEqual(classifyBridgeError(domAbort), { code: 'ABORTED', category: 'cancelled', retryable: false });
});

test('bridge: classifyBridgeError — pipeline errors via classifyOutcome', () => {
    const withStatus = (httpStatus, message = 'x') => Object.assign(new Error(message), { code: 'UPSTREAM_HTTP_ERROR', httpStatus });
    assert.deepEqual(classifyBridgeError(withStatus(429, 'slow down')), { code: 'UPSTREAM_HTTP_ERROR', category: 'rate-limit', retryable: true });
    assert.deepEqual(classifyBridgeError(withStatus(502)), { code: 'UPSTREAM_HTTP_ERROR', category: 'provider-error', retryable: true });
    assert.deepEqual(classifyBridgeError(withStatus(401)), { code: 'UPSTREAM_HTTP_ERROR', category: 'auth', retryable: false });
    assert.deepEqual(classifyBridgeError(withStatus(402, 'insufficient_quota')), { code: 'UPSTREAM_HTTP_ERROR', category: 'quota', retryable: false });
    assert.deepEqual(classifyBridgeError(withStatus(400, 'content policy violation detected')), { code: 'UPSTREAM_HTTP_ERROR', category: 'content-policy', retryable: false });
    // 200 OK without an image is a provider-side parse gap: provider-error, retryable.
    const noImage = Object.assign(new Error('response 200 OK without an image'), { code: 'UPSTREAM_RESPONSE_INVALID' });
    assert.deepEqual(classifyBridgeError(noImage), { code: 'UPSTREAM_RESPONSE_INVALID', category: 'provider-error', retryable: true });
    // CORS/transport ambiguity stays retryable network-unknown.
    const cors = Object.assign(new Error('Failed to fetch'), { code: 'MULTIPART_CORS_REQUIRED' });
    assert.deepEqual(classifyBridgeError(cors), { code: 'MULTIPART_CORS_REQUIRED', category: 'network-unknown', retryable: true });
    // Timeouts are transient.
    assert.deepEqual(classifyBridgeError(new Error('Request timeout after 60s')), { code: null, category: 'timeout', retryable: true });
    // Plain pipeline errors from materialization: billed, but not stored — internal, never blind-retry.
    assert.deepEqual(classifyBridgeError(new Error('no place to store the image')), { code: null, category: 'internal', retryable: false });
    // No error at all → unknown bucket, code null.
    assert.deepEqual(classifyBridgeError(null), { code: null, category: 'unknown', retryable: false });
});

test('bridge: sanitizeBridgeCard strips internals and attributes caller', () => {
    const card = sanitizeBridgeCard({
        id: 'card-1',
        imagePath: 'user/images/Studio/uris_ext_offstage_x.png',
        thumbPath: 'user/images/Studio/thumbs/uris_ext_offstage_x.png',
        prompt: 'a nice scene',
        connectionId: 'conn-1',
        modelId: 'model-x',
        aspectRatio: '9:16',
        width: 768,
        height: 1344,
        status: 'ready',
        referenceIds: ['ref-1'],
        createdAt: 1700000000000,
        provenance: { requestId: 'ext_offstage_9f6c1d2e-1234-aaaa-bbbb-ccccdddddddd', chatId: 'secret-chat', output: { internal: true } },
        stage2Snapshot: { heavy: 'blob' },
        style: { heavy: 'blob' },
    });
    assert.equal(card.caller, 'offstage');
    assert.equal(card.requestId, 'ext_offstage_9f6c1d2e-1234-aaaa-bbbb-ccccdddddddd');
    assert.equal(card.thumbPath, 'user/images/Studio/thumbs/uris_ext_offstage_x.png');
    assert.equal(card.imageSize, null); // not set on this card
    // Internal blobs never cross the bridge.
    for (const forbidden of ['provenance', 'style', 'stage2Snapshot', 'refs', 'refsSig']) {
        assert.ok(!Object.hasOwn(card, forbidden), `card must not expose ${forbidden}`);
    }
    // Manual cards have no caller attribution.
    const manual = sanitizeBridgeCard({ id: 'c2', imagePath: 'user/images/x.png', provenance: 'native' });
    assert.equal(manual.caller, null);
    assert.equal(manual.requestId, null);
    assert.equal(manual.status, 'ready');
    assert.equal(manual.hidden, false);
    // Missing-file status survives sanitizing.
    const missing = sanitizeBridgeCard({ id: 'c3', imagePath: 'user/images/x.png', status: 'missing', hidden: true });
    assert.equal(missing.status, 'missing');
    assert.equal(missing.hidden, true);
    // Garbage → null, never throws.
    assert.equal(sanitizeBridgeCard(null), null);
    assert.equal(sanitizeBridgeCard('card'), null);
    assert.equal(sanitizeBridgeCard([]), null);
    // Long prompts are clipped.
    const longPrompt = sanitizeBridgeCard({ id: 'c4', imagePath: 'user/images/x.png', prompt: 'p'.repeat(10_000) });
    assert.equal(longPrompt.prompt.length, 4096);
});

test('bridge: sanitizeBridgePendingRecord strips bindings, keeps counts', () => {
    const rec = sanitizeBridgePendingRecord({
        id: 'ext_lab_a1b2c3d4',
        requestId: 'ext_lab_a1b2c3d4',
        status: 'dispatchingUnknown',
        createdAt: '2026-09-23T12:00:00.000Z',
        error: null,
        connId: 'conn-1',
        modelId: 'model-x',
        aspectRatio: '1:1',
        prompt: 'p'.repeat(3000),
        referenceIds: ['r1', 'r2'],
        referenceBindings: [{ description: 'secret prompt fragment' }],
    });
    assert.equal(rec.requestId, 'ext_lab_a1b2c3d4');
    assert.equal(rec.caller, 'lab');
    assert.equal(rec.connectionId, 'conn-1');
    assert.equal(rec.referenceCount, 2);
    assert.equal(rec.status, 'dispatchingUnknown');
    assert.ok(!Object.hasOwn(rec, 'referenceBindings'), 'bindings (prompt bodies) must not cross the bridge');
    assert.equal(rec.prompt.length, 2000);
    // id-only records are accepted; unusable input is null.
    assert.equal(sanitizeBridgePendingRecord({ id: 'whatever' })?.requestId, 'whatever');
    assert.equal(sanitizeBridgePendingRecord({}), null);
    assert.equal(sanitizeBridgePendingRecord(null), null);
});

test('bridge: normalizeGalleryQuery clamps and validates', () => {
    assert.deepEqual(normalizeGalleryQuery(undefined), { caller: null, limit: 50, offset: 0, includeHidden: false });
    assert.deepEqual(normalizeGalleryQuery('garbage'), { caller: null, limit: 50, offset: 0, includeHidden: false });
    assert.deepEqual(normalizeGalleryQuery({ caller: ' lab ', limit: 10, offset: 5, includeHidden: true }), { caller: 'lab', limit: 10, offset: 5, includeHidden: true });
    // Limit is capped at 200, offset floors at 0, fractions truncate.
    const clamped = normalizeGalleryQuery({ limit: 99_999, offset: -3.7 });
    assert.equal(clamped.limit, 200);
    assert.equal(clamped.offset, 0);
    assert.equal(normalizeGalleryQuery({ limit: 2.9 }).limit, 2);
    // A caller filter must be a valid caller tag.
    assertBridgeError(() => normalizeGalleryQuery({ caller: 'bad caller' }), 'INVALID_PARAMS');
});

test('bridge: v0.9.6 surface composition', async () => {
    const bridge = activateBridge();
    try {
        for (const method of ['generateFromScene', 'listGallery', 'getCard', 'removeCard', 'listPending', 'getCapabilities', 'listTriggers', 'classifyError']) {
            assert.equal(typeof bridge[method], 'function', `bridge.${method} must be a function`);
        }
        // classifyError is the same classifier the pipeline uses internally.
        assert.equal(bridge.classifyError(bridgeError('NO_CONNECTION', 'x')).category, 'config');
        // Frozen: the new surface cannot be monkey-patched either.
        assert.throws(() => { 'use strict'; globalThis.URIS.listGallery = () => {}; });
    } finally {
        deactivateBridge();
    }
});

test('bridge: gallery/recovery/capability reads respect the gate and validation order', async () => {
    const { state } = await import('../src/core.js');
    const savedSettings = state.settings;
    const savedST = globalThis.SillyTavern;
    const bridge = activateBridge();
    try {
        // Gate down (node default): reads reject EXT_DISABLED, callers are
        // still validated FIRST (attribution errors are the consumer's bug).
        await assert.rejects(() => bridge.removeCard('card-1', {}), e => e.code === 'INVALID_CALLER');
        await assert.rejects(() => bridge.listGallery(), e => e.code === 'EXT_DISABLED');
        await assert.rejects(() => bridge.getCard('card-1'), e => e.code === 'EXT_DISABLED');
        await assert.rejects(() => bridge.listPending(), e => e.code === 'EXT_DISABLED');
        await assert.rejects(() => bridge.getCapabilities('conn-x'), e => e.code === 'EXT_DISABLED');
        await assert.rejects(() => bridge.listTriggers(), e => e.code === 'EXT_DISABLED');
        await assert.rejects(() => bridge.generateFromScene({ text: 'x' }, {}), e => e.code === 'INVALID_CALLER');

        state.settings = { enabled: true, bridgeEnabled: true };
        // Validation runs before any store/provider is touched.
        await assert.rejects(() => bridge.getCard('  '), e => e.code === 'INVALID_PARAMS');
        await assert.rejects(() => bridge.getCard(42), e => e.code === 'INVALID_PARAMS');
        await assert.rejects(() => bridge.removeCard('   ', { caller: 'lab' }), e => e.code === 'INVALID_PARAMS');
        await assert.rejects(() => bridge.listGallery({ caller: 'bad caller' }), e => e.code === 'INVALID_PARAMS');
        await assert.rejects(() => bridge.listPending({ caller: 'bad caller' }), e => e.code === 'INVALID_PARAMS');

        // listTriggers: дефолтный реестр, без тел промптов (prefix/suffix не отдаются).
        const triggers = await bridge.listTriggers();
        assert.ok(triggers.some(t => t.id === 'img'));
        const selfie = triggers.find(t => t.id === 'selfie');
        assert.deepEqual(selfie.aliases, ['selfie', 'селфи']);
        assert.equal(selfie.aspect, '9:16');
        for (const forbidden of ['prefix', 'suffix']) {
            assert.ok(!Object.hasOwn(selfie, forbidden), `trigger must not expose ${forbidden}`);
        }

        // listPending: localforage-стаб — пустое хранилище и caller-фильтр.
        globalThis.SillyTavern = { libs: { localforage: { getItem: async () => null } } };
        assert.deepEqual(await bridge.listPending(), []);
        globalThis.SillyTavern = {
            libs: {
                localforage: {
                    getItem: async () => [{
                        kind: 'browserRequest',
                        id: 'ext_lab_a1b2c3d4',
                        requestId: 'ext_lab_a1b2c3d4',
                        status: 'dispatchingUnknown',
                        createdAt: new Date().toISOString(),
                        prompt: 'paysage',
                        connId: 'conn-1',
                        referenceIds: ['r1'],
                    }],
                },
            },
        };
        const all = await bridge.listPending();
        assert.equal(all.length, 1);
        assert.equal(all[0].caller, 'lab');
        assert.equal(all[0].referenceCount, 1);
        assert.equal((await bridge.listPending({ caller: 'lab' })).length, 1);
        assert.equal((await bridge.listPending({ caller: 'other' })).length, 0);

        // getCapabilities: unknown connection → coded NO_CONNECTION.
        globalThis.SillyTavern = { getContext: () => ({ extensionSettings: {} }) };
        await assert.rejects(() => bridge.getCapabilities('nope-404'), e => e.code === 'NO_CONNECTION');
    } finally {
        state.settings = savedSettings;
        if (savedST === undefined) delete globalThis.SillyTavern; else globalThis.SillyTavern = savedST;
        deactivateBridge();
        assert.equal(globalThis.URIS, undefined);
    }
});
