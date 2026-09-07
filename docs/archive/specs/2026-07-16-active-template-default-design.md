# Active Template as the Generation Default

## Problem

The Templates tab currently marks one template as active by writing it to the active bundle. Each message-scoped generation draft stores only `templateId`, and a newly created draft starts with `templateId: null`. As a result, navigating to a new post resets the Generate tab to the base mode instead of using the active template.

## Goals

- Make the Templates tab's active template the default for all future generations.
- Preserve a user's explicit template choice for an individual post.
- Treat an explicit choice of the base mode as an individual-post override too.
- Use the same resolution rules in the Generate UI, manual Stage 1, automatic generation, and queued generation.
- Keep the existing active-template/bundle model and avoid a second persistence store.

## Non-goals

- Changing how templates themselves are stored or classified.
- Applying a newly active template retroactively to drafts with explicit choices.
- Introducing template priority or multiple simultaneously active templates.

## Data Model

Extend `GenerationDraft` with:

```js
templateSelection: 'default' | 'override'
```

The existing `templateId` remains `string|null`:

- `templateSelection: 'default'` means the draft follows the current `state.activeTemplateId`. Its `templateId` is a cached/derived value only and must not be treated as an explicit choice.
- `templateSelection: 'override'` means the draft uses exactly its own `templateId`. `null` is valid and means the user explicitly selected the base mode.

New drafts are created as:

```js
{
  templateSelection: 'default',
  templateId: null,
  ...
}
```

## Effective Template Resolution

Add one shared resolver at the generation-draft/pipeline boundary:

```js
resolveDraftTemplateId(draft, activeTemplateId)
```

Rules:

1. If `draft.templateSelection === 'override'`, return `draft.templateId` (including `null`).
2. Otherwise return the current `activeTemplateId`.
3. Missing `templateSelection` in an old draft is normalized conservatively:
   - non-null `templateId` is treated as an explicit override;
   - null `templateId` is treated as default.

The resolver must be used before Stage 1 template loading and anywhere a generation input is created from a draft. The effective id is allowed to be passed through runtime payloads, but it must not overwrite the draft's explicit/default selection mode.

## UI Behavior

The Generate tab's template selector displays the effective selection:

- default mode: select `state.activeTemplateId` if it exists, otherwise the base option;
- override mode: select the draft's own `templateId`, including the base option when it is null.

Changing the selector always persists:

```js
{ templateSelection: 'override', templateId: selectedIdOrNull }
```

The Templates tab's "Make active" action continues to update only the active bundle template. It does not modify message drafts. Therefore:

- drafts in default mode follow the new active template on next render/generation;
- drafts in override mode remain unchanged;
- a draft explicitly set to base remains on base even when an active template exists.

The selector should make the distinction visible without adding a second control: default-mode posts show the active template as selected, while the existing post-local selection remains persisted when changed.

## Pipeline and Queue

- Manual Stage 1 resolves the effective template id from the current draft/default before loading the template.
- Manual Stage 2 keeps the draft's selection state unchanged; its `templateId` in snapshots represents the effective template used by the draft at submission time.
- Automatic event payloads may continue to omit a template id; the processing path must resolve the current draft/default consistently before Stage 1.
- Queue items capture an effective template choice for the queued operation only when needed, but must not accidentally turn a default-mode draft into an override. The preferred path is to resolve from the draft at processing time, with explicit queue selections still honored where already supported.

## Migration and Compatibility

Existing drafts without `templateSelection` are normalized on read or through a pure helper:

- `templateId` set → `override`;
- `templateId` null/missing → `default`.

This preserves existing non-null per-post selections. Historical explicit selections of the base mode cannot be reconstructed because the old model stored them as null; those drafts become default-mode after migration.

No destructive storage migration is required. Saving a normalized draft may persist the new field during normal updates.

## Error Handling

- A missing or deleted active template resolves to the base mode (`null`) without throwing.
- A draft override pointing to a deleted template also resolves to base mode at execution time, while the draft retains its explicit override semantics until the user changes it.
- Selector rendering must tolerate a stored override id that is not present in the current template list.

## Testing

Add focused tests for:

1. New drafts default to `templateSelection: 'default'`.
2. Legacy drafts with non-null `templateId` normalize to `override`.
3. Legacy drafts with null `templateId` normalize to `default`.
4. Default-mode drafts resolve to the current active template.
5. Override-mode drafts resolve to their own template id.
6. Override-mode drafts with null resolve to base mode.
7. Changing the active template affects default-mode drafts but not overrides.
8. Generate markup selects the effective default template for a fresh draft.
9. Selecting the base mode persists an explicit override.
10. Stage 1 receives the same effective template id that the UI displays.

## Acceptance Criteria

- Opening a new post with no local template choice shows and uses the currently active template.
- Changing the active template changes the behavior of all default-mode posts on their next generation.
- A post with an explicitly selected template keeps using it after the active template changes.
- A post explicitly set to base keeps using base after the active template changes.
- Manual, automatic, and queued Stage 1 paths use identical effective-template resolution.
- Existing drafts continue working without a one-time destructive migration.
