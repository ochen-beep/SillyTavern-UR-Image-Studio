// Регрессия 2026-10-06: импорт бэкапа принимал произвольные id как есть, а рендер
// вставлял их в HTML-атрибуты (data-id/data-folder/data-preset) без экранирования —
// крафтовый файл бэкапа давал сохранённый XSS. Теперь границы приёма режут алфавит
// через sanitizeId (SAFE_ID_RE), а DOM-рендеры дополнительно экранируют атрибуты.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeId, SAFE_ID_RE } from '../src/core.js';
import { normalizePoolReference, normalizeFolder } from '../src/refs-library.js';
import { sanitizeGalleryCard } from '../src/gallery-index.js';
import { normalizeImageParam } from '../src/param-presets.js';

const EVIL = '<img src=x onerror="alert(1)">';
const UID_RE = /^[0-9a-z]+$/; // алфавит uid(): Date.now()+random в base36

test('sanitizeId пропускает только безопасный алфавит', () => {
    assert.equal(sanitizeId(EVIL), null);
    assert.equal(sanitizeId('a"b'), null);
    assert.equal(sanitizeId('a b'), null);
    assert.equal(sanitizeId('a><script'), null);
    assert.equal(sanitizeId(123), null);
    assert.equal(sanitizeId(undefined), null);
    // легитимные форматы: uid() base36, bridge-атрибуция ext_<caller>_<uuid>,
    // рукописные кириллические id в данных и тестах
    assert.equal(sanitizeId('m1abc123xyz'), 'm1abc123xyz');
    assert.equal(sanitizeId('ext_phone_ab12cd34'), 'ext_phone_ab12cd34');
    assert.equal(sanitizeId('другая'), 'другая');
    assert.equal(SAFE_ID_RE.test('x'.repeat(129)), false);
});

test('normalizePoolReference: крафтовый id заменяется uid-ом', () => {
    const ref = normalizePoolReference({ id: EVIL, name: 'x' });
    assert.match(ref.id, UID_RE);
    assert.doesNotMatch(ref.id, /[<>"' ]/);
});

test('normalizePoolReference: folders с мусором отбрасываются, валидные остаются', () => {
    const ref = normalizePoolReference({ folders: [EVIL, 'ok_id-1', 42, ''] });
    assert.deepEqual(ref.folders, ['ok_id-1']);
});

test('normalizePoolReference: валидный id сохраняется (идемпотентность мержа)', () => {
    const once = normalizePoolReference({ id: 'ref123', name: 'x' });
    const twice = normalizePoolReference({ ...once });
    assert.equal(twice.id, 'ref123');
});

test('normalizeFolder: крафтовые id и parentId заменяются', () => {
    const folder = normalizeFolder({ id: EVIL, parentId: EVIL, name: 'папка' });
    assert.match(folder.id, UID_RE);
    assert.equal(folder.parentId, null);
    const child = normalizeFolder({ id: 'folder1', parentId: 'folder0' });
    assert.equal(child.parentId, 'folder0');
});

test('sanitizeGalleryCard: крафтовый id заменяется uid-ом', () => {
    const card = sanitizeGalleryCard({
        id: EVIL,
        imagePath: 'user/images/UR%20Image%20Studio/abc.png',
    });
    assert.match(card.id, UID_RE);
    assert.doesNotMatch(card.id, /[<>"' ]/);
});

test('sanitizeGalleryCard: existing id не перетирается, валидный входной сохраняется', () => {
    const base = { id: 'card1', imagePath: 'user/images/f/abc.png' };
    assert.equal(sanitizeGalleryCard({ id: EVIL, imagePath: base.imagePath }, base).id, 'card1');
    assert.equal(sanitizeGalleryCard({ id: 'card2', imagePath: base.imagePath }).id, 'card2');
});

test('normalizeImageParam: крафтовый id заменяется uid-ом даже после спреда data', () => {
    const preset = normalizeImageParam({ id: EVIL, name: 'пресет' });
    assert.match(preset.id, UID_RE);
    assert.equal(preset.name, 'пресет');
    assert.equal(normalizeImageParam({ id: 'preset1' }).id, 'preset1');
});
