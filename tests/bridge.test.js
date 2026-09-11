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
    markBridgeReady,
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
