// @ts-check
/** Prompt-template persistence. Only base mode and instruction records are supported. */
import { uid, log, state, saveSettings } from './core.js';
import { recordDiagnosticEvent } from './diagnostic-events.js';
import {
    applyTemplateMutation,
    ensureTemplateStoreReady,
    listTemplateRecords,
    replaceTemplateRecords,
} from './template-file-store.js';

let cachedTemplates = null;
let testStore = null;

/** Server user-file store (data/<user>/user/files/uris_templates.json). */
function fileStore() {
    return {
        available: async () => true,
        list: listTemplateRecords,
        create: async payload => applyTemplateMutation(records => {
            records.push(structuredClone(payload));
            return structuredClone(payload);
        }),
        update: async (id, payload) => applyTemplateMutation(records => {
            const index = records.findIndex(item => item.id === id);
            if (index === -1) return null;
            records[index] = structuredClone(payload);
            return structuredClone(payload);
        }),
        delete: async id => applyTemplateMutation(records => {
            const index = records.findIndex(item => item.id === id);
            if (index !== -1) records.splice(index, 1);
            return true;
        }),
    };
}

async function store() {
    if (testStore) return testStore;
    await ensureTemplateStoreReady();
    return fileStore();
}

export function setTemplateStoreForTests(value) {
    testStore = value;
    cachedTemplates = null;
}

export function resetTemplateStoreForTests() {
    testStore = null;
    cachedTemplates = null;
}

/**
 * Drop the in-memory template cache so the next listTemplates()/getTemplate()
 * re-reads from the store. Call after external mutations that bypass this
 * module's CRUD (backup import, server-store migration, direct settings edit)
 * - otherwise the cache stays stale and hides the new data.
 */
export function invalidateTemplateCache() {
    cachedTemplates = null;
}

export function classifyTemplate(template) {
    if (template == null) return 'base';
    if (template.type === 'instruction' && typeof template.instruction === 'string') return 'instruction';
    throw new Error('Unsupported template format');
}

function isSupportedTemplate(template) {
    try {
        return classifyTemplate(template) === 'instruction';
    } catch {
        return false;
    }
}

export async function listTemplates() {
    if (cachedTemplates === null) {
        const result = await (await store()).list();
        cachedTemplates = Array.isArray(result) ? result : [];
    }
    return cachedTemplates.filter(template => {
        if (isSupportedTemplate(template)) return true;
        log('Ignoring unsupported template record', template?.id || '(missing id)');
        return false;
    });
}

export async function getTemplate(id) {
    return (await listTemplates()).find(template => template.id === id) || null;
}

export async function createInstructionTemplate(data = {}) {
    const now = Date.now();
    const item = {
        id: uid(),
        name: String(data.name || '').trim() || 'Новый шаблон',
        type: 'instruction',
        instruction: typeof data.instruction === 'string' ? data.instruction : '',
        createdAt: now,
        updatedAt: now,
    };
    if (cachedTemplates === null) await listTemplates();
    const persisted = await (await store()).create(item);
    // Refused write (readonly session): the store returns nothing to cache.
    if (!persisted) return null;
    if (!cachedTemplates.some(template => template.id === persisted.id)) cachedTemplates.push(persisted);
    recordDiagnosticEvent({ event: 'template-crud', stage: 'templates', operation: 'create', details: { id: persisted.id } });
    log('Создан instruction-шаблон', persisted.id);
    return persisted;
}

export async function saveTemplate(patch) {
    if (!patch?.id) return null;
    if (patch.type !== 'instruction' || typeof patch.instruction !== 'string') {
        if (patch.type === 'instruction') throw new Error('Instruction template content must be a string');
        throw new Error('Unsupported template format');
    }
    if (cachedTemplates === null) await listTemplates();
    // Index into the RAW cache: the filtered listTemplates() projection can skip
    // unsupported legacy records, which used to shift indices and corrupt the cache.
    const index = cachedTemplates.findIndex(template => template.id === patch.id);
    if (index === -1) return null;
    const next = { ...cachedTemplates[index], ...patch, id: patch.id, type: 'instruction', updatedAt: Date.now() };
    const persisted = await (await store()).update(patch.id, next);
    if (!persisted) return null;
    cachedTemplates[index] = persisted;
    recordDiagnosticEvent({ event: 'template-crud', stage: 'templates', operation: 'update', details: { id: patch.id } });
    return persisted;
}

export async function deleteTemplate(id) {
    await (await store()).delete(id);
    if (cachedTemplates !== null) cachedTemplates = cachedTemplates.filter(template => template.id !== id);
    const map = state?.settings?.accordionState;
    if (map && typeof map === 'object') {
        const orphanKey = `templates:advanced:${id}`;
        if (orphanKey in map) {
            delete map[orphanKey];
            saveSettings();
        }
    }
    log('Удалён шаблон промпта', id);
    recordDiagnosticEvent({ event: 'template-crud', stage: 'templates', operation: 'delete', details: { id } });
}

/**
 * Backup import / rollback: replace the whole record set with the restored
 * settings content and await durability. No-op in legacy mode (the settings
 * restore already carries the templates there). Returns whether the file store
 * accepted the records.
 */
export async function replaceTemplateStoreRecords(records) {
    const replaced = await replaceTemplateRecords(records);
    if (replaced) cachedTemplates = null;
    return replaced;
}

/**
 * Fresh records for export. Null in legacy mode — the exporter then keeps
 * reading templates from settings, as before.
 */
export async function getTemplateRecordsForExport() {
    return listTemplateRecords();
}
