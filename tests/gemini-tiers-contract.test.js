// @ts-check
// Контракт двух таблиц знаний о Gemini image (после сверки с
// docs/providers/chat-completions-aspect-channels.md и ai.google.dev, 2026-09):
//   - dispatch-plan.js  GEMINI_IMAGE_REF_LIMITS   → потолок референсов;
//   - image-model-capabilities.js GEMINI_IMAGE_SIZE_TABLE → тиры imageSize.
// Оси разные (рефы vs разрешение), но поколения моделей в них должны быть
// известны СОГЛАСОВАННО: модель либо известна обеим таблицам, либо обеим
// неизвестна (null = «нет знаний» = пермиссивно). Если 4.x допишут в одну
// таблицу и забудут во второй — знания разъедутся, и этот тест упадёт.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maxReferencesFor } from '../src/dispatch-plan.js';
import { supportedImageSizesFor } from '../src/image-model-capabilities.js';

// Канонические id по поколениям: 3.1 flash (+lite), 3 pro, алиасы
// nano-banana*, 2.x generation. Пополняется при выходе новых поколений —
// вместе с ОБЕИМИ таблицами.
const CANONICAL_GEMINI_IMAGE_MODELS = [
    'gemini-3.1-flash-image',
    'gemini-3.1-flash-lite-image',
    'gemini-3.1-pro-image',
    'gemini-3-pro-image',
    'gemini-2.5-flash-image',
    'google/gemini-2.5-flash-image-preview',
    'nano-banana',
    'nano-banana-2',
    'nano-banana-pro',
    'gemini-nano-banana-2.1',
    'nano-banana-2.1',
];

test('таблицы реф-лимитов и size-тиров Gemini знают одни и те же поколения', () => {
    for (const modelId of CANONICAL_GEMINI_IMAGE_MODELS) {
        const refs = maxReferencesFor(modelId);
        const sizes = supportedImageSizesFor(modelId);
        assert.equal(
            refs !== null,
            sizes !== null,
            `${modelId}: ref-лимиты (${refs}) и size-тиры (${sizes && sizes.join('/')}) должны быть известны согласованно`,
        );
    }
});

test('согласованная семантика поколений: lite — без 2K/4K, pro — без 512, 2.x — без size', () => {
    const lite = 'gemini-3.1-flash-lite-image';
    assert.equal(supportedImageSizesFor(lite).join('/'), '1K');
    assert.ok(maxReferencesFor(lite) > 0);
    const pro = 'gemini-3.1-pro-image';
    assert.deepEqual(supportedImageSizesFor(pro), ['1K', '2K', '4K']);
    const flash = 'gemini-3.1-flash-image';
    assert.deepEqual(supportedImageSizesFor(flash), ['512', '1K', '2K', '4K']);
    const two = 'gemini-2.5-flash-image';
    assert.deepEqual(supportedImageSizesFor(two), [], '2.x: параметра размера нет');
    assert.equal(maxReferencesFor(two), 3);
    // 2.1 (2026-10): 1K/2K/4K, без 512; новое правило не должно затенить
    // предыдущее поколение — plain nano-banana-2 остаётся с 512.
    const nb21 = 'gemini-nano-banana-2.1';
    assert.deepEqual(supportedImageSizesFor(nb21), ['1K', '2K', '4K'], '2.1: без 512 — он эксклюзив 3.1-flash');
    assert.equal(maxReferencesFor(nb21), 14, '2.1: 10 объектов + 4 персонажа');
    assert.deepEqual(supportedImageSizesFor('nano-banana-2'), ['512', '1K', '2K', '4K']);
});

test('неизвестные модели не запираются ни одной таблицей (null = пермиссивно)', () => {
    for (const future of ['gemini-4-ultra-image', 'gemini-5-flash-image', 'custom-fine-tune-image']) {
        assert.equal(maxReferencesFor(future), null, `${future}: refs неизвестны`);
        assert.equal(supportedImageSizesFor(future), null, `${future}: sizes неизвестны`);
    }
});
