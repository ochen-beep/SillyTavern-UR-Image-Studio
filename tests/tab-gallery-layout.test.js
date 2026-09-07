// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');

function read(path) {
    return readFileSync(join(projectRoot, path), 'utf8');
}

function ruleBodyFor(css, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm'));
    return match?.[1] || null;
}

test('gallery clear uses compact, right-aligned toolbar styling', () => {
    const markup = read('src/ui/tab-gallery.js');
    const css = read('style.css');
    const toolbar = ruleBodyFor(css, '.uris-gallery-toolbar');
    const clear = ruleBodyFor(css, '.uris-gallery-clear');
    const clearButton = markup.match(/<button\b[^>]*\bid="urisGalleryClear"[^>]*>/)?.[0];

    assert.ok(clearButton);
    assert.match(clearButton, /\buris-gallery-clear\b/);
    assert.ok(toolbar);
    assert.match(toolbar, /flex-wrap\s*:\s*wrap/);
    assert.ok(clear);
    assert.match(clear, /margin-left\s*:\s*auto/);
    assert.match(clear, /min-height\s*:\s*32px/);
    assert.match(clear, /flex\s*:\s*0\s+0\s+auto/);
});

test('gallery card loads the small variant lazily; grid renders in chunks', () => {
    const markup = read('src/ui/tab-gallery.js');
    assert.match(markup, /it\.thumbPath \|\| it\.src/, 'сетка должна ходить в миниатюру, если она есть');
    assert.match(markup, /loading="lazy"/, 'миниатюры обязаны лениво грузиться');
    assert.match(markup, /decoding="async"/);
    assert.match(markup, /CHUNK_SIZE = \d+/, 'чанковый рендер для больших галерей');
    assert.match(markup, /uris-gallery-sentinel/, 'сентинел дозагрузки');
});
