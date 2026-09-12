// @ts-check
/**
 * Грамматика инлайн-маркеров: `[[тип: описание]]`.
 * Чистый модуль без зависимостей от SillyTavern — используется движком чата,
 * мостом (URIS.parseInline) и тестами. Тип — [a-zа-яё0-9_-]{1,24} (case-insensitive,
 * ё→е), описание — 1..4000 символов без `[`/`]` (лимит живёт в {1,4000} регулярки;
 * хвостовые пробелы перед `]]` входят в лимит — обрезаются trim-ом ниже).
 * Маркеры внутри code-fence (```) игнорируются.
 * Хвостового `\s*` перед `]]` в регулярке НЕТ сознательно: он пересекается
 * с классом описания и даёт квадратичный бэктрекинг на незакрытых маркерах (ReDoS).
 */

const MARKER_RE = /\[\[\s*([a-zа-яё0-9_-]{1,24})\s*:\s*([^\[\]]{1,4000}?)\]\]/gi;

function normalizeType(rawType) {
    return String(rawType || '').toLowerCase().replaceAll('ё', 'е');
}

/** Диапазоны code-fence ``` … ``` в тексте. Нюанс: обратная кавычка внутри
 * описания открывает фенс раньше и маскирует все последующие маркеры — принято. */
function codeFenceRanges(text) {
    const ranges = [];
    const re = /```[\s\S]*?(?:```|$)/g;
    let m;
    while ((m = re.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
    return ranges;
}

function inRanges(pos, ranges) {
    return ranges.some(([a, b]) => pos >= a && pos < b);
}

/**
 * @param {string} [text] произвольный текст сообщения; null/undefined → []
 * @returns {Array<{type:string, desc:string, raw:string, start:number, end:number}>}
 */
export function parseInline(text) {
    if (typeof text !== 'string' || text.length === 0 || !text.includes('[[')) return [];
    const fences = codeFenceRanges(text);
    /** @type {Array<{type:string, desc:string, raw:string, start:number, end:number}>} */
    const out = [];
    MARKER_RE.lastIndex = 0;
    let m;
    while ((m = MARKER_RE.exec(text)) !== null) {
        if (inRanges(m.index, fences)) continue;
        const desc = m[2].trim();
        if (!desc) continue;
        out.push({
            type: normalizeType(m[1]),
            desc,
            raw: m[0],
            start: m.index,
            end: m.index + m[0].length,
        });
    }
    return out;
}
