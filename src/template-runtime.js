// @ts-check
/**
 * Stage 1 template runtime for base and instruction templates.
 */
import { classifyTemplate } from './prompt-templates.js';
import { getCtx, sanitizePrompt } from './core.js';

/**
 * Expand SillyTavern macros without depending on the removed v3 prompt builder.
 * @param {string} text
 */
export function resolveSTMacros(text) {
    const ctx = getCtx();
    try {
        if (ctx?.substituteParams) return ctx.substituteParams(text);
    } catch {
        // Fall back to the common character and user placeholders.
    }
    const charName = ctx?.characters?.[ctx.characterId]?.name || '{{char}}';
    const userName = ctx?.name1 || '{{user}}';
    return String(text).replaceAll('{{char}}', charName).replaceAll('{{user}}', userName);
}

/** Built-in system instruction for base mode. */
export const BASE_SCENE_INSTRUCTION = `You are an image prompt engineer. Read the scene and any character descriptions provided, then write a single detailed English image generation prompt.

Rules:
- Use only the characters, actions, setting, and events that are actually present in the scene.
- Do not add characters, actions, or details that are not in the scene.
- Use the provided character descriptions as the source of truth for appearance.
- Preserve composition, lighting, mood, and interactions.
- Return ONLY the final image prompt text. No markdown, no JSON, no explanations.`;

/**
 * @param {{template:any, messageText:string, snapshot:import('./scene-context.js').SceneContextSnapshot, macroResolver?:(text:string)=>string}} input
 * @returns {{templateType:'base'|'instruction',system:string,user:string}}
 */
export function buildStage1Messages({ template, messageText, snapshot, macroResolver }) {
    const templateType = classifyTemplate(template);
    const expand = typeof macroResolver === 'function' ? macroResolver : resolveSTMacros;
    const contextBlock = buildContextBlock(snapshot);
    const sceneText = String(messageText || '');
    const user = `Scene:\n"""\n${sanitizePrompt(expand(sceneText)).slice(0, 12000)}\n"""${contextBlock}`;

    if (templateType === 'base') {
        return { templateType, system: BASE_SCENE_INSTRUCTION, user };
    }
    if (!String(template.instruction).trim()) {
        throw new Error('Template instruction is empty');
    }
    return { templateType, system: expand(template.instruction), user };
}

/** @param {import('./scene-context.js').SceneContextSnapshot} snapshot */
function buildContextBlock(snapshot) {
    const descriptions = snapshot.stage1Descriptions || [];
    if (!descriptions.length) return '';
    return `\n\nScene references:\n${descriptions.map(d => `- "${d.name}": ${d.description}`).join('\n')}`;
}

/**
 * @param {{template:any,messageText:string,snapshot:import('./scene-context.js').SceneContextSnapshot,generateText:(system:string,user:string,signal?:AbortSignal,onStatus?:(status:string)=>void)=>Promise<string>,signal?:AbortSignal,onStatus?:(status:string)=>void}} input
 */
export async function executeStage1({ template, messageText, snapshot, generateText, signal, onStatus }) {
    const { templateType, system, user } = buildStage1Messages({ template, messageText, snapshot });
    onStatus?.('requesting');
    const raw = await generateText(system, user, signal, onStatus);
    onStatus?.('parsing');
    return {
        prompt: sanitizePrompt(String(raw || '')),
        templateId: template?.id || null,
        templateType,
        structuredDraft: null,
        sourceMsgId: snapshot.msgId,
        contextRevision: snapshot.contextRevision,
        raw: String(raw || ''),
    };
}
