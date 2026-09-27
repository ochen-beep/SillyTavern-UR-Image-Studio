// @ts-check
/**
 * Barrel: public API of the generation module.
 *
 * Actual implementation is split across modules (see docs
 * docs/archive/specs/2026-07-18-remove-descrefs-and-split-pipeline-design.md):
 *   - pipeline-config.js   — chat-scoped config snapshot + presets resolution + buildCandidates
 *   - pipeline-stage2.js   — runStage2ForDraft + runStage2 (positional adapter)
 *   - pipeline-queue.js    — queue (enqueueGeneration, processQueue, stopQueue)
 *
 * This file only re-exports — importers (index.js, ui/*, tests/*)
 * keep writing `import { ... } from './pipeline.js'` unchanged.
 */
export { createChatConfigSnapshot, resolveActivePresets, buildCandidates } from './pipeline-config.js';
export { runStage1ForDraft, runFullPipelineForDraft } from './pipeline-stage1.js';
export { runStage2ForDraft, runStage2 } from './pipeline-stage2.js';
export { createQueueItem, enqueueGeneration, stopQueue, cancelQueuedItem, cancelForeignQueueItems, resubmitQueueRow } from './pipeline-queue.js';
