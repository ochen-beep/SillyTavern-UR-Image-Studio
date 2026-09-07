// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    MODEL_FAMILIES,
    detectModelFamily,
    maxReferencesFor,
    inferApiShape,
    dialectOrder,
    resolveDispatchPlan,
    referenceEncoding,
    connectionModelId,
    classifyModelCapability,
    partitionLikelyImageModels,
    getVisibleModelChoices,
    assertImageModelEligible,
} = await import('../src/dispatch-plan.js');
const { assertReferencePolicy } = await import('../src/providers/image-base.js');

test('model classification recognizes image aliases without the image token', () => {
    const { imageModels, otherModels } = partitionLikelyImageModels([
        'deepseek-chat', 'nano-banana-pro', 'google/flux-kontext-pro', 'seedream-4-0', 'grok-imagine-image-2.0',
    ]);
    assert.deepEqual(imageModels, ['google/flux-kontext-pro', 'grok-imagine-image-2.0', 'nano-banana-pro', 'seedream-4-0']);
    assert.deepEqual(otherModels, ['deepseek-chat']);
    assert.equal(classifyModelCapability('nano-banana-pro').confidence, 'likely');
});

test('model classification recognizes newly listed provider aliases', () => {
    for (const id of ['krea', 'dreamshaper', 'seedream5-pro', 'nova-canvas', 'klein', 'zimage', 'gptimage-large', 'kontext']) {
        assert.equal(classifyModelCapability(id).kind, 'image', id);
    }
});

test('nai-diffusion variants are visible image aliases without inventing a wire family', () => {
    const ids = ['nai-diffusion', 'nai_diffusion', 'naidiffusion', 'vendor/nai-diffusion', 'nai-diffusion-v2'];
    assert.deepEqual(partitionLikelyImageModels(ids).imageModels, ids.slice().sort((a, b) => a.localeCompare(b)));
    for (const id of ids) {
        assert.equal(classifyModelCapability(id).kind, 'image', id);
        assert.equal(detectModelFamily(id), MODEL_FAMILIES.UNKNOWN, id);
        const plan = resolveDispatchPlan({ endpoint: 'https://linkapi.ai/v1', model: { id } });
        assert.equal(plan.dialect, 'openai-images', id);
    }
    assert.equal(classifyModelCapability('nai-diffusion', { mediaKind: 'text' }).kind, 'non-image');
    assert.throws(
        () => resolveDispatchPlan({ endpoint: 'https://linkapi.ai/v1', model: { id: 'nai-diffusion' }, detected: { modelMetadata: [{ modelId: 'nai-diffusion', mediaKind: 'text' }] } }),
        error => error?.code === 'MODEL_NOT_IMAGE',
    );
});

test('model metadata beats the name heuristic and explicit text stays non-image', () => {
    assert.equal(classifyModelCapability('vendor/opaque', { category: 'image' }).kind, 'image');
    assert.equal(classifyModelCapability('vendor/image-model', { category: 'text' }).kind, 'non-image');
    assert.equal(classifyModelCapability('vendor/opaque', { output_modalities: ['image'] }).kind, 'image');
});

test('visibility policy never falls back to text models when show-all is off', () => {
    assert.deepEqual(getVisibleModelChoices(['chat-a', 'chat-b']).ids, []);
    assert.deepEqual(getVisibleModelChoices(['nano-banana', 'chat-a'], { showAll: true }).ids, ['nano-banana', 'chat-a']);
});

test('explicitly non-image selected models are rejected before dispatch', () => {
    assert.throws(
        () => assertImageModelEligible({ model: { id: 'chat-model' }, detected: { modelMetadata: [{ modelId: 'chat-model', mediaKind: 'text' }] } }),
        error => error?.code === 'MODEL_NOT_IMAGE',
    );
    assert.doesNotThrow(() => assertImageModelEligible({ model: { id: 'private-image' }, detected: { modelMetadata: [] } }));
});
test('detectModelFamily: gemini image and nano-banana aliases resolve to gemini-image', () => {
    assert.equal(detectModelFamily('gemini-2.5-flash-image'), MODEL_FAMILIES.GEMINI_IMAGE);
    assert.equal(detectModelFamily('gemini-3.1-flash-lite-image'), MODEL_FAMILIES.GEMINI_IMAGE);
    assert.equal(detectModelFamily('gemini-3-pro-image-preview'), MODEL_FAMILIES.GEMINI_IMAGE);
    assert.equal(detectModelFamily('nano-banana-2'), MODEL_FAMILIES.GEMINI_IMAGE);
    assert.equal(detectModelFamily('google/nano-banana-pro'), MODEL_FAMILIES.GEMINI_IMAGE);
});


test('detectModelFamily: openai/flux/grok/dall-e families and unknown fallback', () => {
    assert.equal(detectModelFamily('gpt-image-1'), MODEL_FAMILIES.GPT_IMAGE);
    assert.equal(detectModelFamily('gpt-image-2-c'), MODEL_FAMILIES.GPT_IMAGE);
    assert.equal(detectModelFamily('flux-1-kontext-pro'), MODEL_FAMILIES.FLUX_KONTEXT);
    assert.equal(detectModelFamily('grok-imagine-image-2.0'), MODEL_FAMILIES.GROK_IMAGINE);
    assert.equal(detectModelFamily('dall-e-3'), MODEL_FAMILIES.DALL_E);
    assert.equal(detectModelFamily('deepseek-chat'), MODEL_FAMILIES.UNKNOWN);
    // A gemini text model is NOT an image family.
    assert.equal(detectModelFamily('gemini-2.5-flash'), MODEL_FAMILIES.UNKNOWN);
});

test('maxReferencesFor: per-family wire limits', () => {
    assert.equal(maxReferencesFor('gemini-3.1-flash-lite-image'), 14);
    assert.equal(maxReferencesFor('nano-banana-2'), 14);
    assert.equal(maxReferencesFor('gemini-3-pro-image-preview'), 14);
    assert.equal(maxReferencesFor('nano-banana-pro'), 14);
    assert.equal(maxReferencesFor('gemini-2.5-flash-image'), 3);
    assert.equal(maxReferencesFor('gemini-9-flash-image'), null);
    assert.equal(maxReferencesFor('gpt-image-1'), 5);
    assert.equal(maxReferencesFor('flux-1-kontext-pro'), 1);
    assert.equal(maxReferencesFor('grok-imagine-image-2.0'), 3);
    assert.equal(maxReferencesFor('dall-e-2'), 1);
    assert.equal(maxReferencesFor('dall-e-3'), 0);
    assert.equal(maxReferencesFor('mystery-model'), null);
});

test('inferApiShape: host-based inference with openai-compatible default', () => {
    assert.equal(inferApiShape('https://openrouter.ai/api/v1'), 'openrouter');
    assert.equal(inferApiShape('https://generativelanguage.googleapis.com/v1beta'), 'gemini');
    assert.equal(inferApiShape('https://linkapi.ai/v1'), 'openai');
    assert.equal(inferApiShape(''), 'openai');
});

test('dialectOrder: gemini-image on an openai gateway prefers chat-completions', () => {
    assert.deepEqual(
        dialectOrder('openai', MODEL_FAMILIES.GEMINI_IMAGE),
        ['chat-completions', 'gemini-native', 'openai-images'],
    );
    assert.deepEqual(
        dialectOrder('openai', MODEL_FAMILIES.GPT_IMAGE),
        ['openai-images', 'chat-completions'],
    );
    assert.deepEqual(dialectOrder('gemini', MODEL_FAMILIES.GEMINI_IMAGE), ['gemini-native']);
    assert.deepEqual(dialectOrder('openrouter', MODEL_FAMILIES.UNKNOWN), ['openrouter-images']);
});

test('resolveDispatchPlan: linkapi shape — gemini image model on an openai gateway', () => {
    const plan = resolveDispatchPlan({
        endpoint: 'https://linkapi.ai/v1',
        model: { id: 'gemini-3.1-flash-lite-image', source: 'list' },
    });
    assert.ok(plan);
    assert.equal(plan.dialect, 'chat-completions');
    assert.equal(plan.family, MODEL_FAMILIES.GEMINI_IMAGE);
    assert.equal(plan.route.generationContract, 'chat-completions');
    assert.equal(plan.route.contractVersion, 1);
    assert.equal(plan.route.modelId, 'gemini-3.1-flash-lite-image');
    assert.equal(plan.route.capabilities.references, 'unknown');
    assert.equal(plan.route.capabilities.maxReferences, 14);
    assert.equal(plan.route.capabilities.chatCompletionsImageConfig, undefined);
    assert.equal(plan.route.transport.bodyKind, 'json');
});

test('resolveDispatchPlan: explicit chat image config override is route-scoped', () => {
    const plan = resolveDispatchPlan({
        endpoint: 'https://linkapi.ai/v1',
        model: { id: 'gemini-3.1-flash-image-preview' },
        overrides: { chatCompletionsImageConfig: 'openrouter' },
    });
    assert.equal(plan.dialect, 'chat-completions');
    assert.equal(plan.route.capabilities.chatCompletionsImageConfig, 'openrouter');

    const native = resolveDispatchPlan({
        endpoint: 'https://linkapi.ai/v1',
        model: { id: 'gemini-3.1-flash-image-preview' },
        overrides: { dialect: 'gemini-native', chatCompletionsImageConfig: 'openrouter' },
    });
    assert.equal(native.dialect, 'gemini-native');
    assert.equal(native.route.capabilities.chatCompletionsImageConfig, undefined);
});

test('resolveDispatchPlan: NanoGPT image catalog always prefers openai-images compatibility', () => {
    const plan = resolveDispatchPlan({
        endpoint: 'https://nano-gpt.com',
        model: { id: 'gemini-3.1-flash-image-preview' },
        detected: {
            apiShape: 'openai',
            catalogSource: 'nanogpt-image-models',
            modelMetadata: [{ modelId: 'gemini-3.1-flash-image-preview', imageGeneration: true }],
        },
    });
    assert.equal(plan.dialect, 'openai-images');
    assert.deepEqual(plan.alternatives, ['openai-images', 'chat-completions']);
});

test('resolveDispatchPlan: google endpoint speaks gemini-native', () => {
    const plan = resolveDispatchPlan({
        endpoint: 'https://generativelanguage.googleapis.com/v1beta',
        model: { id: 'gemini-2.5-flash-image', source: 'list' },
    });
    assert.ok(plan);
    assert.equal(plan.dialect, 'gemini-native');
    assert.equal(plan.apiShape, 'gemini');
    assert.equal(plan.route.capabilities.maxReferences, 3);
});

test('resolveDispatchPlan: gpt-image on an openai gateway speaks openai-images', () => {
    const plan = resolveDispatchPlan({
        endpoint: 'https://fuzhan.magicv4.ltd/v1',
        model: { id: 'gpt-image-2', source: 'list' },
    });
    assert.ok(plan);
    assert.equal(plan.dialect, 'openai-images');
    assert.equal(plan.route.capabilities.maxReferences, 5);
});

test('resolveDispatchPlan: explicit dialect override wins over the static order', () => {
    const plan = resolveDispatchPlan({
        endpoint: 'https://linkapi.ai/v1',
        model: { id: 'gemini-3.1-flash-lite-image' },
        overrides: { dialect: 'gemini-native' },
    });
    assert.ok(plan);
    assert.equal(plan.dialect, 'gemini-native');
});

test('resolveDispatchPlan: evidence promotes a non-first dialect', () => {
    const plan = resolveDispatchPlan({
        endpoint: 'https://gateway.example/v1',
        model: { id: 'gpt-image-1' },
        evidence: { 'gpt-image-1': { dialect: 'chat-completions', refs: 'confirmed', n: 2 } },
    });
    assert.ok(plan);
    assert.equal(plan.dialect, 'chat-completions');
    assert.equal(plan.route.capabilities.references, 'supported');
});

test('resolveDispatchPlan: detected.apiShape overrides host inference', () => {
    const plan = resolveDispatchPlan({
        endpoint: 'https://proxy.example/v1',
        model: { id: 'gemini-3-pro-image' },
        detected: { apiShape: 'gemini' },
    });
    assert.ok(plan);
    assert.equal(plan.apiShape, 'gemini');
    assert.equal(plan.dialect, 'gemini-native');
});

test('resolveDispatchPlan: dall-e-3 declares references unsupported without a max', () => {
    const plan = resolveDispatchPlan({
        endpoint: 'https://api.openai.com/v1',
        model: { id: 'dall-e-3' },
    });
    assert.ok(plan);
    assert.equal(plan.route.capabilities.references, 'unsupported');
    assert.equal('maxReferences' in plan.route.capabilities, false);
});

test('resolveDispatchPlan: no model — null, caller decides the error', () => {
    assert.equal(resolveDispatchPlan({ endpoint: 'https://x.example/v1' }), null);
    assert.equal(resolveDispatchPlan(null), null);
    assert.equal(connectionModelId({ selectedRoute: { modelId: 'legacy' } }), null);
});

test('synthesized route is accepted by assertReferencePolicy', () => {
    const withRefs = resolveDispatchPlan({
        endpoint: 'https://linkapi.ai/v1',
        model: { id: 'gemini-3.1-flash-lite-image' },
    }).route;
    assert.doesNotThrow(() => assertReferencePolicy(withRefs, { references: [{}, {}] }));

    const dalle = resolveDispatchPlan({
        endpoint: 'https://api.openai.com/v1',
        model: { id: 'dall-e-3' },
    }).route;
    assert.throws(
        () => assertReferencePolicy(dalle, { references: [{}] }),
        (error) => error instanceof Error && error.code === 'REFERENCES_UNSUPPORTED',
    );
});

test('overrides.refs never blocks references regardless of family limit', () => {
    const plan = resolveDispatchPlan({
        endpoint: 'https://linkapi.ai/v1',
        model: { id: 'gemini-3.1-flash-lite-image' },
        overrides: { refs: 'never' },
    });
    assert.equal(plan.route.capabilities.references, 'unsupported');
    assert.equal('maxReferences' in plan.route.capabilities, false);
});

test('overrides.maxRefs tightens but never widens the family limit', () => {
    const tightened = resolveDispatchPlan({
        endpoint: 'https://x.test/v1',
        model: { id: 'gemini-3.1-flash-lite-image' },
        overrides: { maxRefs: 2 },
    });
    assert.equal(tightened.route.capabilities.maxReferences, 2);

    const widened = resolveDispatchPlan({
        endpoint: 'https://x.test/v1',
        model: { id: 'gemini-2.5-flash-image' }, // family limit 3
        overrides: { maxRefs: 9 },
    });
    assert.equal(widened.route.capabilities.maxReferences, 3);

    const zeroed = resolveDispatchPlan({
        endpoint: 'https://x.test/v1',
        model: { id: 'gpt-image-1' },
        overrides: { maxRefs: 0 },
    });
    assert.equal(zeroed.route.capabilities.references, 'unsupported');
});

test('referenceEncoding labels the wire format per dialect', () => {
    assert.match(referenceEncoding('chat-completions'), /image_url/);
    assert.match(referenceEncoding('gemini-native'), /inlineData/);
    assert.match(referenceEncoding('openai-images'), /images\[\]/);
    assert.equal(referenceEncoding('unknown-dialect'), 'unknown-dialect');
});
