# Persistent Stage 1 Prompt Rebuild Design

**Date:** 2026-07-16

## Problem

The Generate tab currently renders one prompt-dependent primary action. With an empty prompt it runs Stage 1 and displays `Построить промпт`. After Stage 1 saves a nonempty prompt, rerendering changes that same action to Stage 2 (`Сгенерировать`), leaving no manual path to run Stage 1 again.

The declared `rebuild-prompt` action is not implemented: decision logic never returns it, rendering does not distinguish it, and the click handler sends every non-`build-prompt` action to Stage 2.

## Required behavior

Stage 1 and Stage 2 must remain independently reachable:

- With an empty prompt, show `Построить промпт`.
- With a nonempty prompt, show `Перестроить промпт` and `Сгенерировать` as separate actions.
- Running Stage 1 again replaces the current prompt with the new Stage 1 result.
- Replacement happens without confirmation, including when the current prompt was manually edited.
- Stage 2 uses the visible saved prompt and never silently reruns Stage 1.
- After either operation and rerendering, all actions valid for the resulting state remain available.

## UI design

The `.uris-gen-actions` container will render independent Stage 1 and Stage 2 buttons instead of multiplexing both stages through one control.

The Stage 1 button label depends only on whether the current prompt is empty:

- empty: `Построить промпт`;
- nonempty: `Перестроить промпт`.

The Stage 2 button is available only when a nonempty prompt can be submitted. Existing busy and disabled behavior remains operation-specific so repeated clicks cannot start duplicate work.

## Event and data flow

The Stage 1 control always calls `runStage1ForDraft()`. A successful result is persisted through the existing draft pipeline and replaces the prompt. The subsequent render preserves a Stage 1 control under its rebuild label and exposes Stage 2.

The Stage 2 control always calls `runStage2ForDraft()` and does not branch through Stage 1. Existing prompt persistence before submission remains unchanged.

No provider, reference-resolution, queue, or automation behavior is changed as part of this fix.

## Testing

Regression coverage will verify:

1. An empty draft exposes Stage 1 as `Построить промпт` and does not offer a runnable Stage 2 action.
2. A draft with a Stage 1 prompt exposes both `Перестроить промпт` and `Сгенерировать`.
3. A manually edited prompt also exposes both actions and rebuilding does not request confirmation.
4. The Stage 1 control dispatches only `runStage1ForDraft()`.
5. The Stage 2 control dispatches only `runStage2ForDraft()`.
6. Rerendering after successful Stage 1 keeps prompt rebuilding reachable.
7. Existing Generate-tab, draft, and scene-first pipeline tests continue to pass.

## Out of scope

Adjacent automation naming and legacy `auto-after` inconsistencies are separate defects and are not included in this change.
