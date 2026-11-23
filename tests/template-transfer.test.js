// @ts-check
// Pure template-transfer helpers: markdown canon, txt/json/docx parsing,
// filename safety and import conflict planning.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    templateToMarkdown, parseTemplateText, parseTemplateJson, docxXmlToText,
    parseFrontmatter, sanitizeFilename, dedupeFileNames, planImport,
} = await import('../src/template-transfer.js');

// ── Export canon ──

test('templateToMarkdown: frontmatter name/type + body, timestamps as ISO', () => {
    const md = templateToMarkdown({
        name: 'Кинорежиссёр',
        type: 'instruction',
        instruction: 'Ты — режиссёр.\nОпиши кадр.',
        createdAt: Date.UTC(2026, 10, 23),
        updatedAt: Date.UTC(2026, 10, 24),
    });
    assert.match(md, /^---\nname: Кинорежиссёр\ntype: instruction\n/);
    assert.match(md, /createdAt: 2026-11-23T00:00:00/);
    assert.match(md, /updatedAt: 2026-11-24T00:00:00/);
    assert.match(md, /\n---\n\nТы — режиссёр\.\nОпиши кадр\.$/);
});

test('templateToMarkdown: name whitespace collapses (single-line frontmatter)', () => {
    const md = templateToMarkdown({ name: 'Многострочное\nимя', instruction: 'x' });
    assert.match(md, /^---\nname: Многострочное имя\n/);
});

// ── Text parsing ──

test('parseTemplateText: frontmatter name wins, body is the instruction', () => {
    const draft = parseTemplateText('---\nname: "Режиссёр"\ntype: instruction\n---\n\nТы — режиссёр.');
    assert.deepEqual(draft, { name: 'Режиссёр', instruction: 'Ты — режиссёр.' });
});

test('parseTemplateText: no frontmatter — name from file, body from text', () => {
    assert.deepEqual(parseTemplateText('Тело инструкции', 'Мой файл'), { name: 'Мой файл', instruction: 'Тело инструкции' });
});

test('parseTemplateText: BOM and CRLF are normalized', () => {
    const draft = parseTemplateText('\uFEFF---\r\nname: X\r\n---\r\n\r\nСтрока 1\r\nСтрока 2');
    assert.equal(draft.name, 'X');
    assert.equal(draft.instruction, 'Строка 1\nСтрока 2');
});

test('parseTemplateText: empty body is rejected', () => {
    assert.equal(parseTemplateText('---\nname: X\n---\n\n   \n'), null);
    assert.equal(parseTemplateText(''), null);
});

test('parseTemplateText: binary garbage with control characters is rejected', () => {
    assert.equal(parseTemplateText('\u0000\u0001\u0002 binary junk'), null);
    assert.equal(parseTemplateText('---\nname: X\n---\n\nok \u0007 beep'), null);
});

test('parseFrontmatter: colon inside value survives (split on first colon)', () => {
    const { meta } = parseFrontmatter('---\nname: Movie: Part 2\n---\nbody');
    assert.equal(meta.name, 'Movie: Part 2');
});

// ── JSON parsing ──

test('parseTemplateJson: single record, array and backup shared.templates', () => {
    const record = { name: 'A', type: 'instruction', instruction: 'ia' };
    assert.deepEqual(parseTemplateJson(record), [{ name: 'A', instruction: 'ia' }]);
    assert.deepEqual(parseTemplateJson([record, { name: 'B', instruction: 'ib' }]).length, 2);
    assert.deepEqual(parseTemplateJson({ shared: { templates: [record] } }), [{ name: 'A', instruction: 'ia' }]);
});

test('parseTemplateJson: unsupported shapes and empty instructions are dropped', () => {
    assert.deepEqual(parseTemplateJson({ type: 'instruction', instruction: '   ' }), []);
    assert.deepEqual(parseTemplateJson({ type: 'base' }), []);
    assert.deepEqual(parseTemplateJson('garbage'), []);
    assert.deepEqual(parseTemplateJson({ shared: {} }), []);
});

// ── docx ──

test('docxXmlToText: runs join in a paragraph, paragraphs join with \\n', () => {
    const xml = '<w:body><w:p><w:r><w:t>Абзац один</w:t></w:r></w:p>'
        + '<w:p><w:r><w:t>второй </w:t></w:r><w:r><w:t>абзац</w:t></w:r></w:p></w:body>';
    assert.equal(docxXmlToText(xml), 'Абзац один\nвторой абзац');
});

test('docxXmlToText: entities decoded, empty paragraphs dropped', () => {
    const xml = '<w:p><w:r><w:t>A &amp; B &lt;tag&gt;</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">   </w:t></w:r></w:p>';
    assert.equal(docxXmlToText(xml), 'A & B <tag>');
});

// ── Filename safety ──

test('sanitizeFilename: illegal chars replaced, trailing dots stripped, capped', () => {
    assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
    assert.equal(sanitizeFilename('Имя...'), 'Имя');
    assert.equal(sanitizeFilename('x'.repeat(100)).length, 80);
    assert.equal(sanitizeFilename(''), 'template');
});

test('dedupeFileNames: duplicate stems get (2), (3); uniques untouched', () => {
    assert.deepEqual(
        dedupeFileNames(['a.md', 'b.md', 'a.md', 'a (2).md', 'a.md']),
        ['a.md', 'b.md', 'a (2).md', 'a (2) (2).md', 'a (3).md'],
    );
});

// ── Import planning ──

const existing = [
    { id: 't1', name: 'Режиссёр' },
    { id: 't2', name: 'Художник' },
];

test('planImport: new names go to toCreate untouched', () => {
    const { toCreate, toOverwrite } = planImport(existing, [{ name: 'Новый', instruction: 'i' }], 'copy');
    assert.deepEqual(toCreate, [{ name: 'Новый', instruction: 'i' }]);
    assert.deepEqual(toOverwrite, []);
});

test('planImport overwrite: existing id is reused (active links survive)', () => {
    const { toCreate, toOverwrite } = planImport(existing, [{ name: 'режиссёр', instruction: 'new text' }], 'overwrite');
    assert.deepEqual(toCreate, []);
    assert.deepEqual(toOverwrite, [{ id: 't1', name: 'режиссёр', instruction: 'new text' }]);
});

test('planImport copy: conflict becomes a clone-style copy, new names stay', () => {
    const { toCreate, toOverwrite } = planImport(
        existing,
        [{ name: 'Режиссёр', instruction: 'i1' }, { name: 'Скульптор', instruction: 'i2' }],
        'copy',
    );
    assert.deepEqual(toOverwrite, []);
    assert.deepEqual(toCreate, [{ name: 'Режиссёр (копия)', instruction: 'i1' }, { name: 'Скульптор', instruction: 'i2' }]);
});
