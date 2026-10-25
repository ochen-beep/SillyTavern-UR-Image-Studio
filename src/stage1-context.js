// @ts-check
/**
 * Контекст Stage 1 из чата (по образцу DS-Comments src/generator.js):
 * карточка {{user}} (персона), карточка {{char}}, записи лорбука и история
 * сообщений — опциональные блоки, добавляемые к Scene-сообщению Stage 1.
 *
 * Логика DS-Comments, воспроизведённая здесь:
 *  - persona: ctx.powerUserSettings.persona_description (generator.js:120);
 *  - character: ctx.characters[ctx.characterId].description (+personality) (generator.js:128);
 *  - lore: книги из chat_metadata.world_info + книга персонажа
 *    (resolveAttachedLorebookSources), записи через ctx.loadWorldInfo (lorebooks.js:190);
 *  - history: последние N сообщений чата до якорного, без is_system/is_hidden,
 *    формат «Имя: текст» (generator.js:157-190).
 *
 * Каждый блок включается своим тумблером в Настройках и обрезается по
 * символам — у Stage 1 свой бюджет контекста, меньший, чем у RP-пресетов.
 */
import { state, log } from './core.js';

const PERSONA_MAX_CHARS = 2000;
const CHARACTER_MAX_CHARS = 4000;
const LORE_MAX_CHARS = 4000;
const HISTORY_MAX_CHARS = 8000;
const HISTORY_MSG_MAX_CHARS = 2000;

/** Прочитанные тумблеры (строгие booleans, depth 0 = выключено). */
export function stage1ContextSettings() {
    const s = state.settings || {};
    return {
        persona: s.stage1IncludePersona === true,
        character: s.stage1IncludeCharacter === true,
        lore: s.stage1IncludeLore === true,
        historyDepth: Number.isFinite(s.stage1HistoryDepth) ? s.stage1HistoryDepth : 0,
    };
}

function clip(text, max) {
    const t = String(text || '').trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
}

/** Карточка {{user}}: powerUserSettings.persona_description. */
export function buildPersonaPart(ctx) {
    try {
        const pd = ctx?.powerUserSettings?.persona_description;
        if (!pd || !String(pd).trim()) return '';
        return `[Persona ({{user}}):\n${clip(pd, PERSONA_MAX_CHARS)}]`;
    } catch { return ''; }
}

/** Карточка {{char}}: name + description (+personality) активного персонажа. */
export function buildCharacterPart(ctx) {
    try {
        const ch = ctx?.characters?.[ctx?.characterId];
        if (!ch) return '';
        const body = [ch.description, ch.personality].map(p => String(p || '').trim()).filter(Boolean).join('\n');
        if (!body) return '';
        return `[Character ({{char}}): ${String(ch.name || '—')}\n${clip(body, CHARACTER_MAX_CHARS)}]`;
    } catch { return ''; }
}

/** Источники лорбука: книга чата + книга, привязанная к персонажу. */
export function resolveLorebookSources(ctx) {
    const books = [];
    try {
        const chatBook = ctx?.chatMetadata?.world_info;
        if (typeof chatBook === 'string' && chatBook.trim()) books.push(chatBook);
        const ch = ctx?.characters?.[ctx?.characterId];
        const charBook = ch?.extensions?.world;
        if (typeof charBook === 'string' && charBook.trim() && !books.includes(charBook)) books.push(charBook);
    } catch { /* нет чата — нет книг */ }
    return books;
}

/** Записи одной книги через ctx.loadWorldInfo; отключённые и пустые — мимо. */
export async function loadLorebookEntries(ctx, book) {
    if (typeof ctx?.loadWorldInfo !== 'function') return [];
    try {
        const payload = await ctx.loadWorldInfo(book);
        const container = payload?.entries;
        const rows = Array.isArray(container)
            ? container.map(entry => [undefined, entry])
            : container && typeof container === 'object'
                ? Object.entries(container)
                : [];
        const entries = [];
        for (const [key, entry] of rows) {
            if (!entry || typeof entry !== 'object') continue;
            if (entry.disable === true || entry.disabled === true) continue;
            const content = String(entry.content || '').trim();
            if (!content) continue;
            const uid = entry.uid ?? (typeof key === 'string' && /^\d+$/.test(key) ? Number(key) : undefined);
            const label = entry.comment || (Array.isArray(entry.key) ? entry.key[0] : undefined) || `Entry ${uid ?? '?'}`;
            entries.push({ book, uid, label, content });
        }
        entries.sort((a, b) => (a.uid ?? 0) - (b.uid ?? 0));
        return entries;
    } catch (e) {
        log('stage1-context: lorebook load failed for', book, e?.message || e);
        return [];
    }
}

/** Блок лорбука: все записи всех привязанных книг, суммарно ≤ LORE_MAX_CHARS. */
export async function buildLorePart(ctx) {
    const books = resolveLorebookSources(ctx);
    if (!books.length) return '';
    const lines = [];
    let budget = LORE_MAX_CHARS;
    for (const book of books) {
        for (const entry of await loadLorebookEntries(ctx, book)) {
            const line = `- ${entry.label}: ${entry.content}`;
            if (line.length > budget) {
                lines.push(clip(line, budget) + '…');
                return `[Lorebook:\n${lines.join('\n')}]`;
            }
            lines.push(line);
            budget -= line.length;
        }
    }
    return lines.length ? `[Lorebook:\n${lines.join('\n')}]` : '';
}

/**
 * История чата: последние depth сообщений до якорного (msgId), без
 * is_system/is_hidden. Текст берётся из m.mes; имена — как в DS-Comments.
 */
export function buildHistoryPart(ctx, depth, anchorMsgId = null) {
    const d = Number.isFinite(depth) ? Math.floor(depth) : 0;
    if (d <= 0) return '';
    try {
        const chat = ctx?.chat;
        if (!Array.isArray(chat) || !chat.length) return '';
        let endIdx = chat.length;
        if (anchorMsgId != null && Number.isFinite(Number(anchorMsgId))) {
            endIdx = Math.min(Number(anchorMsgId), chat.length);
        }
        const name1 = ctx?.name1 || 'User';
        const picked = [];
        for (let i = endIdx - 1; i >= 0 && picked.length < d; i--) {
            const m = chat[i];
            if (!m || m.is_system === true || m.is_hidden === true) continue;
            const text = String(m.mes || '').trim();
            if (!text) continue;
            const name = m.is_user ? name1 : (m.name || ctx?.name2 || 'Character');
            picked.push(`${name}: ${clip(text, HISTORY_MSG_MAX_CHARS)}`);
        }
        picked.reverse();
        if (!picked.length) return '';
        return `[Chat history (earlier messages; context only, do NOT react to these as current):\n${clip(picked.join('\n'), HISTORY_MAX_CHARS)}]`;
    } catch { return ''; }
}

/**
 * Собрать все включённые блоки. Возвращает массив строк — отдельных
 * user-сообщений для профильного пути (Connection Manager передаёт массив
 * as-is) или склеенных '\n\n' для кастомного (text-api).
 * @returns {Promise<string[]>}
 */
export async function buildStage1ContextParts(ctx, { msgId = null } = {}) {
    const cfg = stage1ContextSettings();
    const parts = [];
    if (cfg.persona) parts.push(buildPersonaPart(ctx));
    if (cfg.character) parts.push(buildCharacterPart(ctx));
    if (cfg.lore) parts.push(await buildLorePart(ctx));
    if (cfg.historyDepth > 0) parts.push(buildHistoryPart(ctx, cfg.historyDepth, msgId));
    return parts.filter(Boolean);
}
