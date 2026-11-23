// @ts-check
/**
 * File transfer for prompt templates: markdown+frontmatter canon, txt, json,
 * docx and zip archives. Pure parsing/serialization and import planning live
 * here; UI wiring (buttons, picker, drop zone) is in src/ui/tab-templates.js.
 *
 * The canon export format follows the established prompt-file convention
 * (.prompty / Obsidian): YAML-ish frontmatter carries `name`/`type`, the body
 * carries the instruction. JSZip comes from the SillyTavern host install
 * (public/lib/jszip.min.js) via lazy dynamic import — the same pattern the
 * ST core itself uses — so the extension keeps zero dependencies.
 */

// ── Filename safety ──

const FILENAME_MAX = 80;
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001F]/g;

/**
 * Turn a free-form template name into a safe download/zip-entry filename
 * stem (without extension): illegal characters and Windows-trailing
 * dots/spaces are stripped, length capped.
 */
export function sanitizeFilename(name) {
    let out = String(name ?? '')
        .replace(ILLEGAL_FILENAME_CHARS, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/, '');
    if (out.length > FILENAME_MAX) out = out.slice(0, FILENAME_MAX).trimEnd();
    return out || 'template';
}

/**
 * Make zip entry names unique: duplicates become "stem (2).ext", "stem
 * (3).ext", ... (JSZip silently overwrites same-path entries otherwise).
 * @param {string[]} names
 */
export function dedupeFileNames(names) {
    const used = new Set();
    return names.map(name => {
        if (!used.has(name)) {
            used.add(name);
            return name;
        }
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        let n = 2;
        while (used.has(`${stem} (${n})${ext}`)) n += 1;
        const candidate = `${stem} (${n})${ext}`;
        used.add(candidate);
        return candidate;
    });
}

// ── Export (canon markdown) ──

function frontmatterDate(value) {
    return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

/**
 * Serialize one template record into canon markdown: frontmatter with
 * name/type/timestamps, instruction as the body.
 * @param {{name: string, instruction?: string, createdAt?: number, updatedAt?: number}} record
 */
export function templateToMarkdown(record) {
    const name = String(record.name ?? '').replace(/\s+/g, ' ').trim() || 'Шаблон';
    const lines = ['---', `name: ${name}`, 'type: instruction'];
    const createdAt = frontmatterDate(record.createdAt);
    const updatedAt = frontmatterDate(record.updatedAt);
    if (createdAt) lines.push(`createdAt: ${createdAt}`);
    if (updatedAt) lines.push(`updatedAt: ${updatedAt}`);
    lines.push('---', '', String(record.instruction ?? ''));
    return lines.join('\n');
}

// ── Import parsing ──

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Parse a leading `---` frontmatter block: flat `key: value` lines. */
export function parseFrontmatter(text) {
    const match = FRONTMATTER_RE.exec(text);
    if (!match) return { meta: null, body: text };
    const meta = {};
    for (const line of match[1].split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        let value = line.slice(idx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        meta[line.slice(0, idx).trim().toLowerCase()] = value;
    }
    return { meta, body: text.slice(match[0].length) };
}

/**
 * Parse one text file (md/prompty/txt) into a template draft. The name comes
 * from frontmatter `name`, falling back to the file name. Returns null when
 * the body is empty (nothing to import).
 * @param {string} text raw file content (BOM tolerated)
 * @param {string} [fallbackName] file name without extension
 */
export function parseTemplateText(text, fallbackName = '') {
    const normalized = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const { meta, body } = parseFrontmatter(normalized);
    const instruction = body.trim();
    if (!instruction) return null;
    // Binary garbage masquerading as .txt/.md: real text never carries
    // control characters (tab/newline/carriage return excluded).
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000E-\u001F]/.test(instruction)) return null;
    const name = String(meta?.name ?? '').trim()
        || String(fallbackName ?? '').trim()
        || 'Импортированный шаблон';
    return { name, instruction };
}

/**
 * Parse JSON sources: a single URIS record, an array of records, or a URIS
 * backup (data-port v6+) carrying `shared.templates`. Only instruction
 * records with a non-empty instruction survive; anything else is dropped.
 * @param {unknown} parsed
 * @returns {Array<{name: string, instruction: string}>}
 */
export function parseTemplateJson(parsed) {
    let list = [];
    if (Array.isArray(parsed)) {
        list = parsed;
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.shared?.templates)) {
        list = parsed.shared.templates;
    } else if (parsed && typeof parsed === 'object') {
        list = [parsed];
    }
    const drafts = [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        if (item.type && item.type !== 'instruction') continue;
        const instruction = typeof item.instruction === 'string' ? item.instruction.trim() : '';
        if (!instruction) continue;
        drafts.push({
            name: String(item.name ?? '').replace(/\s+/g, ' ').trim() || 'Импортированный шаблон',
            instruction,
        });
    }
    return drafts;
}

// ── docx ──

function decodeXmlEntities(text) {
    return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, entity => {
        if (entity === '&amp;') return '&';
        if (entity === '&lt;') return '<';
        if (entity === '&gt;') return '>';
        if (entity === '&quot;') return '"';
        if (entity === '&apos;') return "'";
        const code = entity[3] === 'x'
            ? parseInt(entity.slice(4, -1), 16)
            : parseInt(entity.slice(3, -1), 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    });
}

/**
 * Extract paragraph text from word/document.xml: runs join inside a
 * paragraph, paragraphs join with newlines, empty paragraphs drop.
 * @param {string} xml
 */
export function docxXmlToText(xml) {
    return xml
        .split(/<\/w:p>/)
        .map(paragraph => [...paragraph.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
            .map(m => decodeXmlEntities(m[1]))
            .join(''))
        .filter(p => p.trim().length > 0)
        .join('\n');
}

// ── JSZip from the SillyTavern host ──

// The served depth of an extension differs by install type (user extensions
// live at /scripts/extensions/third-party/<name>/, bundled ones at
// /scripts/extensions/<name>/), so no single relative path is correct.
// Try the known depths once, then cache whichever resolves. Built lazily:
// this module also loads under plain node:test, where `location` is absent.
function jsZipCandidates() {
    return [
        new URL('../../../../../lib/jszip.min.js', import.meta.url), // third-party user extension
        new URL('../../../../lib/jszip.min.js', import.meta.url), // bundled extension
        new URL('../../lib/jszip.min.js', import.meta.url), // extension served from its own root
        new URL('/lib/jszip.min.js', location.origin), // ST serves public assets from the site root
    ];
}

let jsZipPromise = null;

async function loadJsZip() {
    jsZipPromise ??= (async () => {
        for (const url of jsZipCandidates()) {
            try {
                const mod = await import(url.href);
                // jszip.min.js is a UMD build: under native ESM it registers
                // globalThis.JSZip and exposes no module exports at all.
                const JSZip = mod.default ?? mod.JSZip ?? globalThis.JSZip;
                if (typeof JSZip === 'function') return JSZip;
            } catch {
                // wrong install depth — try the next candidate
            }
        }
        throw new Error('JSZip not found in the SillyTavern host (public/lib/jszip.min.js)');
    })();
    return jsZipPromise;
}

/** Test seam: swap the host JSZip loader (browser-only dependency). */
export function setJsZipLoaderForTests(loader) {
    jsZipPromise = loader ? loader() : null;
}

export { loadJsZip };

// ── File collection (picker / drop / zip) ──

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.prompty']);
// Guards binary-as-text garbage: a real instruction file is kilobytes.
const MAX_TEXT_LENGTH = 2 * 1024 * 1024;

function fileExtension(name) {
    const dot = name.lastIndexOf('.');
    return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

function nameWithoutExtension(name) {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
}

async function sourceText(source) {
    if (typeof source.text === 'function') return source.text(); // File
    return source.async('string'); // JSZip entry
}

/**
 * Parse one non-archive source (a picked File or a JSZip entry) and push
 * drafts. @returns {Promise<number>} records added (0 = failed)
 */
async function addNonZip(name, source, records, ext) {
    const stem = nameWithoutExtension(name);
    if (ext === '.json') {
        const text = await sourceText(source);
        if (!text || text.length > MAX_TEXT_LENGTH) return 0;
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            return 0;
        }
        const drafts = parseTemplateJson(parsed);
        records.push(...drafts);
        return drafts.length;
    }
    if (ext === '.docx') {
        const JSZip = await loadJsZip();
        const archive = await JSZip.loadAsync(typeof source.async === 'function' ? await source.async('blob') : source);
        const xml = await archive.file('word/document.xml')?.async('string');
        if (!xml) return 0;
        const draft = parseTemplateText(docxXmlToText(xml), stem);
        if (!draft) return 0;
        records.push(draft);
        return 1;
    }
    if (TEXT_EXTENSIONS.has(ext)) {
        const text = await sourceText(source);
        if (!text || text.length > MAX_TEXT_LENGTH) return 0;
        const draft = parseTemplateText(text, stem);
        if (!draft) return 0;
        records.push(draft);
        return 1;
    }
    return 0;
}

/**
 * Parse a picked/dropped FileList into template drafts.
 * @param {Iterable<File>} files
 * @returns {Promise<{records: Array<{name: string, instruction: string}>, failed: number}>}
 */
export async function collectTemplates(files) {
    const records = [];
    let failed = 0;
    for (const file of files) {
        try {
            const ext = fileExtension(file.name);
            if (ext === '.zip') {
                const JSZip = await loadJsZip();
                const archive = await JSZip.loadAsync(file);
                // Flat unpack: inner files go through the same parsers; nested
                // archives are reported as failures, not recursed.
                for (const entry of Object.values(archive.files)) {
                    if (entry.dir) continue;
                    try {
                        const ext = fileExtension(entry.name);
                        if (ext === '.zip' || !(await addNonZip(entry.name, entry, records, ext))) failed += 1;
                    } catch {
                        failed += 1;
                    }
                }
                continue;
            }
            if (!(await addNonZip(file.name, file, records, ext))) failed += 1;
        } catch {
            failed += 1;
        }
    }
    return { records, failed };
}

// ── Import planning ──

function normalizeName(name) {
    return String(name ?? '').trim().toLowerCase();
}

/**
 * Resolve name conflicts against the current templates. `overwrite` reuses
 * the existing record id (active-template links survive); `copy` keeps the
 * incoming record and appends the clone suffix.
 * @param {Array<{id: string, name: string}>} existing
 * @param {Array<{name: string, instruction: string}>} drafts
 * @param {'overwrite'|'copy'} conflictPolicy
 * @returns {{toCreate: Array<{name: string, instruction: string}>, toOverwrite: Array<{id: string, name: string, instruction: string}>}}
 */
export function planImport(existing, drafts, conflictPolicy) {
    const byName = new Map(existing.map(template => [normalizeName(template.name), template]));
    const toCreate = [];
    const toOverwrite = [];
    for (const draft of drafts) {
        const conflict = byName.get(normalizeName(draft.name));
        if (!conflict) {
            toCreate.push(draft);
        } else if (conflictPolicy === 'overwrite') {
            toOverwrite.push({ id: conflict.id, name: draft.name, instruction: draft.instruction });
        } else {
            toCreate.push({ ...draft, name: `${draft.name} (копия)` });
        }
    }
    return { toCreate, toOverwrite };
}

// ── Download helper ──

/**
 * Trigger a browser download for a blob (same mechanics as data-port
 * downloadJson, for any mime type).
 * @param {string} filename
 * @param {Blob} blob
 */
export function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
