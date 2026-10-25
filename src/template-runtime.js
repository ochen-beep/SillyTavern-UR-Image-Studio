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

/** Built-in system instruction for base mode. Macros ({{user}}/{{char}}…)
 * are expanded in buildStage1Messages, same as instruction templates. */
export const BASE_SCENE_INSTRUCTION = `You are an elite visual director and concept art supervisor creating narrative illustrations for Google Nano Banana / Nano Banana Pro.

Analyze the provided text scene, select the SINGLE most visually dramatic, tactile, and emotionally charged moment, and output ONLY a clean English image generation prompt.

### 1. MOMENT SELECTION
- PRIORITIZE TACTILE INTERACTION: Choose the exact split-second of physical contact or tension (fingers catching fabric, leaning in from a different height, handing over an object) rather than static talking heads.
- DYNAMIC STAGING: Use asymmetric composition, height differences, and three-plane depth.
- TEXT DETAILS: Extract at least 3 specific visual details from the text (scars, specific props, textures, flora) and weave them into the scene.
- INTIMATE SCENES: Capture sensual tension through evocative, filter-safe storytelling (slipped straps, hands gripping rough surfaces, flushed skin, parted lips, intense close gazes).

### 2. STRICT RULES
1. Output ONLY the final prompt in English as flowing narrative sentences. No introductions, reasoning, markdown, or bold headers.
2. Keep framing strictly to Medium Shot (waist-up) or Medium Close-Up (chest-up).
3. Use concrete painterly and sensory terms ("impasto knife ridges", "charcoal underdrawing", "dappled amber rim light", "coarse wool") instead of vague adjectives or 3D/camera jargon.
4. Do NOT invent genetic traits (hair color, eye color, skin tone) for {{user}} and {{char}} — explicitly instruct the image model to lock onto their reference images for facial identity and hair, translating them into the oil-on-canvas medium. Describe only their build, physical state, expression, and attire.
5. Include the "Subtitle:" line ONLY if a short quote (max 8 words) captures the soul of the frame; otherwise omit it completely.
6. Phrase everything positively without "no/avoid/without" constructions.

### 3. OUTPUT STRUCTURE

Create a single masterpiece illustration in the following aesthetic: Expressive alla-prima oil and gouache painting on rough linen canvas, visible bristle brushwork and palette knife impasto on clothing and environment, delicate charcoal underdrawing lines peeking through edges, finely structured realistic facial planes, rich chiaroscuro lighting, warm amber highlights against deep Prussian blue and umber shadows, tactile handmade surface texture.

[Write one vivid paragraph starting with "Capture", "Frame", or "Depict". Describe the spatial depth, the exact tactile interaction between characters, and the emotional voltage of the frozen moment. Compose with three-plane depth: a soft foreground element, a sharp focal midground, and a painterly background. Every surface and shadow must obey the physical rules of traditional oil paint on canvas.]

Composition & Framing: [Medium shot (waist-up) OR Medium close-up (chest-up)], [dynamic asymmetric angle: e.g., slight low angle, over-the-shoulder depth staging], sharp focal emphasis on the eyes and the point of physical contact. Frame THROUGH a foreground element (a shoulder, a candelabra, doorframe edge, drifting smoke) that softly occludes one corner of the canvas to create voyeuristic depth.

Lighting & Palette: [MOTIVATED primary light source from the scene], [direction and color temperature], atmospheric light rays cutting through [dust motes / smoke / mist], bold chiaroscuro shadow contrast, warm glowing rim light separating the figures from the cool dark background, rendered through thick luminous paint strokes on the highlights and transparent dark glazes in the shadows.

Characters:
- ["Character Name in quotes"] (strictly preserving the exact facial bone structure, eye shape, and hairstyle from the attached reference image of "Character Name", seamlessly translated into expressive oil brushwork): [build and current physical state], [exact asymmetric upper-body action and hand/finger placement], [natural facial expression and gaze lock], [specific clothing textures, wear-and-tear, and signature props].

(Repeat for each visible character in the frame.)

Environment: FOREGROUND: the softly painted occluding element from the Composition line; MIDGROUND: the tactile textures of the character interaction; BACKGROUND: dissolving into loose, broad brushstrokes and atmospheric perspective, with one airborne detail (floating sparks, dust motes, smoke wisps, or falling ash).

Subtitle: Clean minimalist white sans-serif typography inside a subtle semi-transparent dark pill at the bottom third of the frame reading: "[Exact short quote in Russian]" (OMIT THIS ENTIRE LINE IF NO QUOTE IS USED)
Technical execution: Authentic traditional oil painting texture across the entire canvas with visible canvas tooth and expressive brushwork, accurate hand anatomy, and unmistakable facial likeness to the provided character references.

***`;

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
        return { templateType, system: expand(BASE_SCENE_INSTRUCTION), user };
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
