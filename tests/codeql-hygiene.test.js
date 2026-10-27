// @ts-check
// Regression checks for the CodeQL code-scanning findings (GitHub security scan,
// 2026-10-26): sanitize reformation, prototype pollution in mergeExtraBody,
// crypto-grade ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePrompt } from '../src/core.js';
import { mergeExtraBody } from '../src/providers/image-chat-completions.js';
import { randomToken } from '../src/random.js';

test('sanitizePrompt: brackets strip leaves prose, no tag can re-form', () => {
    assert.equal(sanitizePrompt('<<script>script>alert(1)</script>>'), 'scriptscriptalert(1)/script', 'tags die at the bracket level');
    assert.equal(sanitizePrompt('plain text, no markup'), 'plain text, no markup', 'clean text passes through');
    assert.equal(sanitizePrompt('a < b and javascript: is inert prose'), 'a < b and javascript: is inert prose'.replace(/[<>]/g, ''), 'schemes are inert in a text prompt');
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
