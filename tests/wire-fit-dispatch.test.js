// @ts-check
// Wire-copy fitting lives in the registry so every contract gets it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchWithWireFit } from '../src/image-provider-registry.js';

const GEMINI_INLINE_BUDGET = 18 * 1024 * 1024;
const ref = (kb, mime = 'image/png') => {
    const data = 'A'.repeat(kb * 1024);
    return { dataUrl: `data:${mime};base64,${data}`, mimeType: mime, data };
};
const invocation = (references, generationContract = 'openai-images') => ({
    route: { generationContract },
    request: { prompt: 'Edit this' },
    parsedReferences: references,
});
const httpError = status => Object.assign(new Error(`HTTP ${status}`), { httpStatus: status });

test('without a budget the adapter gets the stored references untouched', async () => {
    const stored = [ref(10)];
    let seen;
    const result = await dispatchWithWireFit(async input => { seen = input.parsedReferences; return 'ok'; }, invocation(stored), {
        fit: async () => { throw new Error('fit must not run'); },
    });
    assert.equal(result, 'ok');
    assert.equal(seen, stored);
});

test('inline contracts fit under the documented Gemini request ceiling', async () => {
    const stored = [ref(10)];
    const calls = [];
    await dispatchWithWireFit(async () => 'ok', invocation(stored, 'gemini-native'), {
        fit: async (...args) => { calls.push(args); return null; },
    });
    assert.deepEqual(calls, [[stored, GEMINI_INLINE_BUDGET, 'Edit this']]);
});

test('a fitted copy reaches the adapter while the stored references stay untouched', async () => {
    const stored = [ref(900)];
    const tiered = [ref(100, 'image/jpeg')];
    let seen;
    await dispatchWithWireFit(async input => { seen = input.parsedReferences; return 'ok'; }, invocation(stored, 'gemini-interactions'), {
        fit: async () => tiered,
    });
    assert.equal(seen, tiered);
    assert.equal(stored[0].mimeType, 'image/png');
});

test('HTTP 413 retries once with every reference at the wire tier', async () => {
    const stored = [ref(900)];
    const tiered = [ref(100, 'image/jpeg')];
    const budgets = [];
    // A budget under the JSON envelope slack is one no body can meet: tier all.
    const fit = async (references, budget) => { budgets.push(budget); return budget < 4096 ? tiered : null; };
    const attempts = [];
    const adapter = async input => {
        attempts.push(input.parsedReferences);
        if (attempts.length === 1) throw httpError(413);
        return 'ok';
    };
    assert.equal(await dispatchWithWireFit(adapter, invocation(stored, 'gemini-native'), { fit }), 'ok');
    assert.deepEqual(attempts, [stored, tiered]);
    assert.equal(budgets[0], GEMINI_INLINE_BUDGET);
    assert.ok(budgets[1] < 4096);
});

test('HTTP 413 with nothing left to shrink is rethrown after a single attempt', async () => {
    let attempts = 0;
    const adapter = async () => { attempts += 1; throw httpError(413); };
    await assert.rejects(
        dispatchWithWireFit(adapter, invocation([ref(900)], 'gemini-native'), { fit: async references => references }),
        /HTTP 413/,
    );
    assert.equal(attempts, 1);
});

test('other upstream errors are not retried', async () => {
    let attempts = 0;
    const adapter = async () => { attempts += 1; throw httpError(500); };
    await assert.rejects(dispatchWithWireFit(adapter, invocation([ref(10)]), { fit: async () => null }), /HTTP 500/);
    assert.equal(attempts, 1);
});
