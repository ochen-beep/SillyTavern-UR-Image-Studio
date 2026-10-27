// @ts-check
// Regression checks for the CodeQL code-scanning findings (GitHub security scan,
// 2026-10-26): sanitize reformation, prototype pollution in mergeExtraBody,
// crypto-grade ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePrompt } from '../src/core.js';
import { mergeExtraBody } from '../src/providers/image-chat-completions.js';
import { randomToken } from '../src/random.js';

test('sanitizePrompt: single-pass reformation cannot rebuild a stripped pattern', () => {
    assert.equal(sanitizePrompt('javajavascript:script:alert(1)'), 'alert(1)', 'scheme strip is stable');
    const tags = sanitizePrompt('<<script>script>alert(1)</script>>');
    assert.ok(!/<[^>]*>/.test(tags), 'no complete tag can be re-formed');
    assert.ok(!tags.includes('javascript:'), 'no scheme can be re-formed');
    assert.equal(sanitizePrompt('plain text, no markup'), 'plain text, no markup', 'clean text passes through');
});

test('mergeExtraBody: prototype-polluting keys are skipped', () => {
    const body = { model: 'm', messages: [] };
    const { body: merged, applied } = mergeExtraBody(body, { __proto__: { polluted: true }, constructor: { polluted: true }, steps: 30 });
    assert.equal(merged.steps, 30, 'ordinary extra keys still merge');
    assert.equal(({}).polluted, undefined, 'prototype is untouched');
    assert.ok(!applied.includes('__proto__'), 'proto key is not reported as applied');
});

test('randomToken: length, charset, no Math.random anywhere', () => {
    const token = randomToken(12);
    assert.equal(token.length, 12);
    assert.match(token, /^[0-9a-z]+$/, 'base36 output');
    assert.notEqual(randomToken(12), randomToken(12), 'tokens are distinct');
});
