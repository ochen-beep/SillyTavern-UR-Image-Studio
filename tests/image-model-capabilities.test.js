// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { supportedImageSizesFor, imageSizeSupported, unsupportedImageSizeReason, IMAGE_SIZE_TIERS } from '../src/image-model-capabilities.js';

test('lite-модель ограничена 1K — это документированная особенность, а не догадка', () => {
  // ai.google.dev: "Gemini 3.1 Flash Lite Image only supports 1K resolution."
  assert.deepEqual(supportedImageSizesFor('gemini-3.1-flash-lite-image'), ['1K']);
  assert.equal(imageSizeSupported('gemini-3.1-flash-lite-image', '1K'), true);
  assert.equal(imageSizeSupported('gemini-3.1-flash-lite-image', '2K'), false);
  assert.equal(imageSizeSupported('gemini-3.1-flash-lite-image', '4K'), false);
  assert.match(unsupportedImageSizeReason('gemini-3.1-flash-lite-image', '2K'), /поддерживает только 1K/);
});

test('2.x поколение не имеет параметра размера вовсе', () => {
  for (const id of ['gemini-2.5-flash-image', 'google/gemini-2.5-flash-image', 'nano-banana']) {
    assert.deepEqual(supportedImageSizesFor(id), [], id);
    assert.equal(imageSizeSupported(id, '1K'), false, id);
    assert.match(unsupportedImageSizeReason(id, '1K'), /не имеет параметра размера/, id);
  }
});

test('3.x pro и flash различаются наборами тиров', () => {
  assert.deepEqual(supportedImageSizesFor('gemini-3-pro-image-preview'), ['1K', '2K', '4K']);
  assert.deepEqual(supportedImageSizesFor('gemini-3.1-flash-image'), ['512', '1K', '2K', '4K']);
  assert.deepEqual(supportedImageSizesFor('gemini-3.1-flash-image-preview'), ['512', '1K', '2K', '4K']);
  // lite-правило должно проверяться раньше flash-правила, иначе lite получит 512
  assert.equal(imageSizeSupported('gemini-3.1-flash-lite-image', '512'), false);
  // 1K — единственный тир, общий для всех: отправка его не должна предупреждать
  for (const [, tiers] of [['pro', ['1K', '2K', '4K']], ['flash', ['512', '1K', '2K', '4K']]]) {
    assert.ok(tiers.includes('1K'));
  }
});

test('алиасы nano-banana раскрываются в те же наборы', () => {
  assert.deepEqual(supportedImageSizesFor('nano-banana-pro'), ['1K', '2K', '4K']);
  assert.deepEqual(supportedImageSizesFor('nano-banana-2'), ['512', '1K', '2K', '4K']);
});

test('неизвестные модели не запираются: null = «нет знаний», а не запрет', () => {
  for (const id of ['gpt-image-2.5', 'flux-kontext-pro', 'some-new-image-model', '', null, undefined]) {
    assert.equal(supportedImageSizesFor(id), null, String(id));
    assert.equal(imageSizeSupported(id, '4K'), null, String(id));
    assert.equal(unsupportedImageSizeReason(id, '4K'), null, String(id));
  }
});

test('пустой или отсутствующий размер не даёт причины для отказа', () => {
  assert.equal(unsupportedImageSizeReason('gemini-3.1-flash-lite-image', ''), null);
  assert.equal(unsupportedImageSizeReason('gemini-3.1-flash-lite-image', '  '), null);
  assert.deepEqual(IMAGE_SIZE_TIERS, ['512', '1K', '2K', '4K']);
});
