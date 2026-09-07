// @ts-check

const MAX_DESCRIPTION_CHARS = 2000;

function cleanLabel(value, fallback) {
    const label = String(value || '').replace(/[\r\n]+/g, ' ').trim();
    return label || fallback;
}

function cleanDescription(value) {
    return String(value || '')
        .replace(/\[\/?REFERENCE(?: BINDINGS| DESCRIPTIONS)?\]/gi, '')
        .replace(/[\r\n]{3,}/g, '\n\n')
        .trim()
        .slice(0, MAX_DESCRIPTION_CHARS);
}

/**
 * Compose provider-facing reference context without mutating the saved prompt.
 * @param {string} prompt
 * @param {Array<object>} references
 * @returns {{effectivePrompt:string, bindings:Array<object>, textOnlyReferences:Array<object>}}
 */
export function composeReferencePrompt(prompt, references = []) {
    const bindings = [];
    const textOnlyReferences = [];
    const seen = new Set();
    let imageIndex = 0;

    for (const ref of Array.isArray(references) ? references : []) {
        const id = String(ref?.id || '');
        const mode = ref?.bindingMode === 'description' ? 'description' : 'image';
        const description = cleanDescription(ref?.description);
        if (mode === 'description' && !description) {
            const error = new Error(`Reference description is empty: ${ref?.name || id || 'unnamed reference'}`);
            error.code = 'REFERENCE_DESCRIPTION_REQUIRED';
            throw error;
        }
        const key = `${id}:${mode}:${description}`;
        if (seen.has(key)) continue;
        seen.add(key);

        if (mode === 'description') {
            textOnlyReferences.push({ id, label: cleanLabel(ref?.label || ref?.name, `reference ${textOnlyReferences.length + 1}`) });
            continue;
        }
        imageIndex += 1;
        bindings.push({
            id,
            index: imageIndex,
            label: cleanLabel(ref?.label || ref?.name, `reference ${imageIndex}`),
            description: description || null,
            mode: 'image',
        });
    }

    const blocks = [];
    if (bindings.length) {
        blocks.push([
            '[REFERENCE BINDINGS]',
            ...bindings.map(binding => [
                `Reference image ${binding.index} corresponds to "${binding.label}".`,
                'Use it to preserve the recognizable visual appearance of that subject.',
                'Adapt pose, framing, lighting, and background to the scene.',
            ].join(' ')),
            '[/REFERENCE BINDINGS]',
        ].join('\n'));
    }
    if (textOnlyReferences.length) {
        blocks.push([
            '[REFERENCE DESCRIPTIONS]',
            ...textOnlyReferences.map(ref => `"${ref.label}": ${cleanDescription(references.find(item => String(item?.id || '') === ref.id)?.description)}`),
            '[/REFERENCE DESCRIPTIONS]',
        ].join('\n'));
    }
    const basePrompt = String(prompt || '').trim();
    return {
        effectivePrompt: blocks.length ? `${basePrompt}\n\n${blocks.join('\n\n')}` : basePrompt,
        bindings,
        textOnlyReferences,
    };
}

export { MAX_DESCRIPTION_CHARS };
