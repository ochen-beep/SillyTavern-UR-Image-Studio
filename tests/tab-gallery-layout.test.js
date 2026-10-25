// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readAllStyles } from './_helpers.js';

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

test('gallery refresh/clear buttons live in settings «Данные и диагностика»', () => {
    const gallery = read('src/ui/tab-gallery.js');
    const settings = read('src/ui/tab-settings.js');
    const css = readAllStyles();
    // Кнопки переехали из тулбара галереи в раздел данных настроек (v0.9.5):
    // тулбар остаётся счётчиком, старые классы/правила не должны оставаться.
    assert.doesNotMatch(gallery, /urisGalleryRefresh|urisGalleryClear|uris-gallery-clear/);
    assert.equal(ruleBodyFor(css, '.uris-gallery-clear'), null, 'мёртвое правило тулбара удалено');
    assert.match(settings, /Данные и диагностика[\s\S]*id="urisTabGalleryRefresh"[\s\S]*id="urisTabGalleryClear"/,
        'обе кнопки рендерятся в секции «Данные и диагностика», обновление раньше очистки');
});

test('gallery card loads the small variant lazily; grid renders in chunks', () => {
    const markup = read('src/ui/tab-gallery.js');
    assert.match(markup, /it\.thumbPath \|\| it\.src/, 'сетка должна ходить в миниатюру, если она есть');
    assert.match(markup, /loading="lazy"/, 'миниатюры обязаны лениво грузиться');
    assert.match(markup, /decoding="async"/);
    assert.match(markup, /CHUNK_SIZE = \d+/, 'чанковый рендер для больших галерей');
    assert.match(markup, /uris-gallery-sentinel/, 'сентинел дозагрузки');
});
