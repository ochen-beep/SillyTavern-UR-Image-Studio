// @ts-check
// Coordinate-space helper для зумленного поддерева (.uris-tabs/.uris-body).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveZoom, visualWidth } from '../src/ui/zoom.js';

test('effectiveZoom: currentCSSZoom — приоритетный источник', () => {
    assert.equal(effectiveZoom({ currentCSSZoom: 1.25 }), 1.25);
    // Спека: элемент без бокса (display:none) отчитывается единицей.
    assert.equal(effectiveZoom({ currentCSSZoom: 0 }), 1);
    assert.equal(effectiveZoom({ currentCSSZoom: NaN }), 1);
});

test('effectiveZoom: fallback на computed zoom, когда currentCSSZoom нет', () => {
    const original = globalThis.getComputedStyle;
    globalThis.getComputedStyle = () => ({ zoom: '1.5' });
    try {
        assert.equal(effectiveZoom({}), 1.5);
    } finally {
        globalThis.getComputedStyle = original;
    }
});

test('effectiveZoom: мусор, отсутствие API, null — безопасная единица', () => {
    const original = globalThis.getComputedStyle;
    globalThis.getComputedStyle = () => ({ zoom: 'garbage' });
    try {
        assert.equal(effectiveZoom({}), 1);
    } finally {
        globalThis.getComputedStyle = original;
    }
    globalThis.getComputedStyle = () => { throw new Error('detached'); };
    try {
        assert.equal(effectiveZoom({}), 1);
    } finally {
        globalThis.getComputedStyle = original;
    }
    assert.equal(effectiveZoom(null), 1);
    assert.equal(effectiveZoom(undefined), 1);
});

test('visualWidth пересчитывает clientWidth в визуальные (post-zoom) px', () => {
    assert.equal(visualWidth({ clientWidth: 400, currentCSSZoom: 1.25 }), 500);
    assert.equal(visualWidth({ clientWidth: 300 }), 300); // нет данных о зуме → 1
    assert.equal(visualWidth(null), 0);
});
