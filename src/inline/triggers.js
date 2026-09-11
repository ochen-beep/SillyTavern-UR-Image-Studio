// @ts-check
/**
 * Реестр триггер-профилей инлайна. Профили глобальные (общие для чат-движка
 * и моста: bridge `generate({trigger})` резолвится сюда). Хранение списка —
 * в state.settings.inlineTriggers (проводка в Task 9); здесь — чистые операции.
 */

export const REFS_POLICIES = ['auto', 'off'];

export const DEFAULT_TRIGGERS = Object.freeze([
    Object.freeze({
        id: 'img', name: 'Картинка',
        aliases: ['img', 'image', 'картинка', 'фото'],
        aspect: '1:1', prefix: '', suffix: '',
        refsPolicy: 'auto',
    }),
    Object.freeze({
        id: 'selfie', name: 'Селфи',
        aliases: ['selfie', 'селфи'],
        aspect: '9:16',
        prefix: 'candid phone selfie of {{char}}, ',
        suffix: ', natural lighting, authentic phone camera look',
        refsPolicy: 'auto',
    }),
    Object.freeze({
        id: 'scene', name: 'Сцена',
        aliases: ['scene', 'сцена', 'фон'],
        aspect: '16:9',
        prefix: 'cinematic establishing shot, ',
        suffix: '',
        refsPolicy: 'off',
    }),
]);

const ID_RE = /^[a-zа-яё0-9_-]{1,24}$/;

/** Нормализация одной записи; бросает при отсутствии алиасов/невалидном id. */
export function normalizeTrigger(data = {}) {
    // Алиасы проверяем первыми: контракт тестов — вызов без алиасов бросает
    // ошибку про aliases, даже если id тоже отсутствует.
    const aliases = [...new Set((Array.isArray(data.aliases) ? data.aliases : [])
        .map(a => String(a || '').trim().toLowerCase().replaceAll('ё', 'е'))
        .filter(Boolean))];
    if (!aliases.length) throw new Error('trigger aliases required');
    const id = String(data.id || '').trim().toLowerCase().replaceAll('ё', 'е');
    if (!ID_RE.test(id)) throw new Error('trigger id invalid');
    const policy = REFS_POLICIES.includes(data.refsPolicy) ? data.refsPolicy : 'auto';
    return {
        id, name: String(data.name || '').trim() || id, aliases,
        aspect: String(data.aspect || '1:1').trim(),
        prefix: String(data.prefix || '').trim(),
        suffix: String(data.suffix || '').trim(),
        refsPolicy: policy,
    };
}

/** Список: нормализация, дедуп по id (первый wins), id `img` гарантированно есть. */
export function sanitizeTriggerList(list) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
        let t;
        try { t = normalizeTrigger(raw); } catch { continue; }
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        out.push(t);
    }
    if (!seen.has('img')) out.unshift(normalizeTrigger(DEFAULT_TRIGGERS[0]));
    return out;
}

/** Алиас (lower, ё→е) → профиль. */
export function buildAliasIndex(triggers) {
    const idx = new Map();
    for (const t of triggers) for (const a of t.aliases) if (!idx.has(a)) idx.set(a, t);
    return idx;
}

export function resolveProfile(aliasIndex, type) {
    return aliasIndex.get(String(type || '').toLowerCase().replaceAll('ё', 'е')) || null;
}

/**
 * Промпт инлайна: prefix + описание + suffix, макросы ST разворачиваются.
 * @param {{prefix:string, suffix:string}} trigger
 * @param {string} desc
 * @param {{charName?: string, userName?: string}} [macroFallback]
 */
export function buildInlinePrompt(trigger, desc, macroFallback = {}) {
    const expand = (s) => {
        let out = String(s || '');
        const charName = macroFallback.charName || '{{char}}';
        const userName = macroFallback.userName || '{{user}}';
        out = out.replaceAll('{{char}}', charName).replaceAll('{{user}}', userName);
        return out;
    };
    return `${expand(trigger.prefix)}${String(desc || '').trim()}${expand(trigger.suffix)}`.trim();
}
