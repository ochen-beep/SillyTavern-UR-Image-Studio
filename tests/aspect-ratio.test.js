// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRatio, reducedRatio, aspectDeviates, promptAspectConflicts, ASPECT_TOLERANCE } from '../src/aspect-ratio.js';
import { VALID_ASPECT_RATIOS } from '../src/core.js';

test('parseRatio принимает только W:H с положительными целыми', () => {
  assert.deepEqual(parseRatio('9:16'), { w: 9, h: 16 });
  assert.deepEqual(parseRatio(' 16 : 9 '), { w: 16, h: 9 });
  assert.equal(parseRatio('16x9'), null);
  assert.equal(parseRatio('0:16'), null);
  assert.equal(parseRatio('9:0'), null);
  assert.equal(parseRatio(''), null);
  assert.equal(parseRatio(null), null);
  assert.equal(parseRatio(undefined), null);
  assert.equal(parseRatio(42), null);
});

test('reducedRatio сокращает на НОД и отвергает мусор', () => {
  assert.equal(reducedRatio(1376, 768), '43:24');
  assert.equal(reducedRatio(768, 1344), '4:7');
  assert.equal(reducedRatio(1920, 1080), '16:9');
  assert.equal(reducedRatio(0, 100), null);
  assert.equal(reducedRatio(10.5, 3), null);
});

test('aspectDeviates: документированный слот Gemini 9:16 (768x1344) не считается промахом', () => {
  // 768x1344 gcd-сокращается до 4:7 — строковое сравнение дробей дало бы
  // ложную тревогу, числовое с допуском проходит.
  assert.equal(aspectDeviates(768, 1344, '9:16'), null);
  assert.equal(aspectDeviates(1344, 768, '16:9'), null);
  assert.equal(aspectDeviates(1024, 1024, '1:1'), null);
});

test('aspectDeviates: наблюдаемый провал ddtnew (1376x768 вместо 9:16) ловится', () => {
  const deviation = aspectDeviates(1376, 768, '9:16');
  assert.ok(deviation !== null && deviation > 1, 'портрет вместо альбома — отклонение больше 100%');
  // умеренный промах тоже виден: 1024x1024 против 16:9
  assert.ok(aspectDeviates(1024, 1024, '16:9') > ASPECT_TOLERANCE);
});

test('aspectDeviates: нет данных для сравнения — null, а не тревога', () => {
  assert.equal(aspectDeviates(null, null, '9:16'), null);
  assert.equal(aspectDeviates(768, 1344, null), null);
  assert.equal(aspectDeviates(768, 1344, 'auto'), null);
  assert.equal(aspectDeviates(768, 1344, undefined), null);
});

test('promptAspectConflicts: явная чужая пропорция в промпте находится', () => {
  assert.deepEqual(promptAspectConflicts('Make it a 16:9 widescreen shot', '9:16'), ['16:9']);
  assert.deepEqual(promptAspectConflicts('vertical 2:3 poster, then 4:3 crop', '9:16').sort(), ['2:3', '4:3']);
  // допустимая запись с пробелами нормализуется
  assert.deepEqual(promptAspectConflicts('a 16 : 9 frame', '1:1'), ['16:9']);
});

test('promptAspectConflicts: совпадающая пропорция и не-пропорции не дают конфликта', () => {
  assert.deepEqual(promptAspectConflicts('portrait 9:16 composition', '9:16'), []);
  // пиксельный слот модели (768x1344 ≈ 9:16 в пределах 2%) не считается конфликтом
  assert.deepEqual(promptAspectConflicts('canvas 768x1344', '9:16'), []);
  // времена, счёт и прочие двоеточия — не аспектные токены
  assert.deepEqual(promptAspectConflicts('clock showing 10:30 in the scene, final score 3:40', '9:16'), []);
  assert.deepEqual(promptAspectConflicts('', '9:16'), []);
  assert.deepEqual(promptAspectConflicts('scene', null), []);
  assert.deepEqual(promptAspectConflicts('scene', 'auto'), []);
});

test('контракт: все предлагаемые UI соотношения проходят конфликт-детектор как легитимные', () => {
  // если в VALID_ASPECT_RATIOS добавят новое значение, детектор обязан его узнавать
  for (const ratio of VALID_ASPECT_RATIOS) {
    const [w, h] = ratio.split(':').map(Number);
    const other = ratio === '16:9' ? '9:16' : '16:9';
    assert.deepEqual(promptAspectConflicts(`frame ${ratio}`, other), [ratio], ratio);
  }
});
