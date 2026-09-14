// @ts-check
/**
 * «Проверить референсы»: one deliberate, paid generation with one tiny
 * reference image. The result lands in the gallery so the user can judge with
 * their own eyes whether the reference was actually USED (a silent ignore is
 * not detectable programmatically), and the outcome is recorded as
 * user-confirmed evidence.
 */
import { generateImageRequest } from './image-api.js';
import { recordReferenceEvidence } from './connection-evidence.js';
import { resolveConnection } from './connections.js';
import { resolveDispatchPlan } from './dispatch-plan.js';

// 1×1 transparent PNG — the smallest valid image data URL. Providers accept
// it as a reference part; the prompt asks for something the model can only
// "know" from the instruction, keeping the check about delivery, not content.
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * Run the paid reference check for a connection.
 *
 * @param {{connectionId:string}} input
 * @param {object} [deps] test seams
 * @returns {Promise<{ok:true, galleryEntry:object|null, dialect:string|null}>}
 * @throws the provider error when the attempt fails
 */
export async function runReferenceCheck({ connectionId }, deps = {}) {
    const generate = deps.generate || generateImageRequest;
    const record = deps.record || recordReferenceEvidence;
    if (!connectionId) throw new Error('Connection is required');

    // Resolve the dialect up front (for the evidence record) the same way
    // dispatch will: plan first, wire stamp as the fallback.
    let dialect = null;
    let modelId = null;
    try {
        const resolved = await resolveConnection(connectionId);
        const plan = resolved ? resolveDispatchPlan(resolved.conn) : null;
        dialect = plan?.dialect || null;
        modelId = plan?.route?.modelId || null;
    } catch { /* evidence is best-effort */ }

    const requestId = `refcheck_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const request = {
        requestId,
        prompt: 'a plain white square centered on a black background, minimal flat test image',
        aspectRatio: '1:1',
        imageSize: '1K',
        quality: 'auto',
        references: [{ id: 'refcheck', name: 'Проверка референсов', dataUrl: TINY_PNG }],
    };
    try {
        const result = await generate(connectionId, request, () => {});
        await record({
            connectionId, modelId,
            dialect: request.editDialect || dialect,
            refCount: 1,
            userConfirmed: true,
        });
        return { ok: true, galleryEntry: result?.galleryEntry || null, dialect: request.editDialect || dialect };
    } catch (error) {
        await record({
            connectionId, modelId,
            dialect: request.editDialect || dialect,
            refCount: 1,
            error,
            userConfirmed: true,
        });
        throw error;
    }
}
