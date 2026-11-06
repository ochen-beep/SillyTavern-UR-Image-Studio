// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFolderWithCards } from '../src/gallery-index.js';

test('mergeFolderWithCards: каждый файл виден, карточка джойнится по пути', () => {
    const items = mergeFolderWithCards(
        ['user/images/Damien/a.png', 'user/images/Damien/b.png'],
        [{ id: 'c1', imagePath: 'user/images/Damien/b.png', prompt: 'b prompt', favorite: true }],
    );
    assert.equal(items.length, 2);
    const cardless = items.find(i => i.imagePath.endsWith('a.png'));
    assert.equal(cardless.id, null);
    assert.equal(cardless.cardless, true);
    assert.equal(cardless.prompt, '');
    const joined = items.find(i => i.imagePath.endsWith('b.png'));
    assert.equal(joined.id, 'c1');
    assert.equal(joined.prompt, 'b prompt');
    assert.equal(joined.favorite, true);
    assert.notEqual(joined.cardless, true);
});

test('mergeFolderWithCards: скрытая карточка скрывает и файл', () => {
    const items = mergeFolderWithCards(
        ['user/images/Damien/a.png'],
        [{ id: 'c1', imagePath: 'user/images/Damien/a.png', hidden: true }],
    );
    assert.equal(items.length, 0);
});

test('mergeFolderWithCards: мусорные пути и дубликаты отсекаются', () => {
    const items = mergeFolderWithCards(
        ['user/images/Damien/a.png', 'user/images/Damien/a.png', '../../etc/passwd', '', null],
        [],
    );
    assert.deepEqual(items.map(i => i.imagePath), ['user/images/Damien/a.png']);
});

test('mergeFolderWithCards: карточки без файлов в папке не порождают элементов', () => {
    const items = mergeFolderWithCards(
        [],
        [{ id: 'c1', imagePath: 'user/images/Damien/gone.png', prompt: 'x' }],
    );
    assert.equal(items.length, 0);
});
