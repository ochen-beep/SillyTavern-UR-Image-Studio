# Pool-Only Reference Resolution Design

**Date:** 2026-07-17

## Goal

Simplify reference resolution so every Stage 2 image comes from the reference
pool. Remove special image sourcing for SillyTavern `{{char}}` and `{{user}}`
avatars. Make automatic matching explicit and stable by using only aliases,
never a reference's display name.

## Design Principles

- A reference pool record is the only source of a Stage 2 image.
- `name` is a display label. Renaming it must not change matching behavior.
- `aliases` are the only phrases that identify a reference in a Stage 1 prompt.
- `role` is optional presentation metadata and does not affect eligibility or
  matching.
- Ambiguous aliases fail closed: no conflicting reference is selected
  automatically.
- A reference without aliases remains available for manual inclusion but is
  never included automatically.

## Data Model

### Reference pool record

```js
{
  id: string,
  name: string,
  aliases: string[],
  imagePath: string,
  description: string,
  role?: 'char' | 'user' | 'npc'
}
```

Field semantics:

- `id`: stable identity used by whitelist and per-message corrections.
- `name`: arbitrary display label used in the library, picker, and chips.
- `aliases`: exact canonical phrases used for prompt matching.
- `imagePath`: image submitted to Stage 2 after materialization.
- `description`: optional descriptive content used by the Stage 1 description
  channel.
- `role`: optional UI label used for caption, color, and display ordering only.

The working model no longer contains `keywords`.

### Chat reference binding

```js
{
  referenceIds: string[],
  descRefs: Array<{ refId: string, mode: 'auto' | 'pinned' }>
}
```

`referenceIds` is the single chat-scoped whitelist from which prompt candidates
are built. `charSlot`, `userSlot`, and `extraRefIds` are removed from the working
model.

`draft.references` remains message-scoped:

```js
{
  includedIds: string[],
  excludedIds: string[],
  revision: number
}
```

These arrays contain stable pool reference IDs. There are no special `char` or
`user` IDs.

## Matching Rules

For each reference in `referenceIds`, the resolver checks every non-empty
alias against the current Stage 1 prompt using the existing strict,
case-insensitive, Unicode-aware whole-token matching.

The display `name`, description, role, and image filename do not participate in
matching.

Examples:

```js
{
  name: 'Серая мышь',
  aliases: ['Рада', 'Rada'],
  role: 'user'
}
```

- `Rada lies beside Ashton` matches this record.
- `Серая мышь enters the room` does not match unless that phrase is also an
  alias.
- Renaming the record to `Пипа` does not change either result.

### Ambiguity

If the same matched alias belongs to multiple whitelisted records, all records
in that alias group are marked ambiguous and none is automatically included.
The user may resolve the ambiguity with a message-scoped manual inclusion.

Exclusions continue to win over automatic matches and manual inclusions.

## Candidate and Stage 2 Flow

1. Load the chat binding.
2. Resolve every `referenceIds` entry to a pool record.
3. Ignore missing pool IDs and records without a usable image for Stage 2.
4. Normalize candidates while preserving each pool record's stable ID.
5. Resolve aliases against the current generated prompt.
6. Apply `draft.references` inclusions and exclusions.
7. Materialize the resulting pool images in deterministic order.

No step reads `ctx.name1`, `ctx.name2`, character avatars, persona IDs,
`/characters/...`, or `/User Avatars/...`.

Manual inclusion is allowed for a whitelisted record without aliases. Adding a
record through the effective Stage 2 picker first adds its pool ID to
`referenceIds`, then adds that same ID to `draft.references.includedIds`.

## Stage 1 Description Channel

`descRefs` remains separate because it controls descriptive text supplied while
building Stage 1 rather than images selected from the completed prompt.

For `mode: 'auto'`, description matching uses the record's `aliases` only.
For `mode: 'pinned'`, the description is always included. Display `name` does
not trigger automatic description inclusion.

## UI

The Generate references panel has two effective concepts:

- **Stage 2 effective strip:** references selected from the current prompt plus
  message-scoped manual corrections.
- **Reference whitelist:** pool records eligible for automatic or manual Stage 2
  inclusion in this chat.

The `{{char}}/{{user}}` slots section is removed. The NPC-specific wording is
also removed because whitelist entries are no longer restricted to NPCs.

Each whitelist chip shows the pool image, display name, and optional role badge.
Role can be unset. The pool editor exposes:

- display name;
- aliases;
- optional role;
- image;
- description.

It no longer exposes keywords. UI search uses display name plus aliases, but UI
search results do not affect prompt matching.

References with no aliases should display a neutral indicator or tooltip that
they require manual inclusion. Conflicting aliases should be surfaced through
the existing ambiguity controls rather than resolved by whitelist order.

## Migration

Migration is idempotent and preserves pool IDs.

For every existing pool record:

```js
aliases = uniqueCaseInsensitive([
  ...existingAliases,
  ...existingKeywords,
])
```

The existing display `name` is deliberately not added to aliases. After
migration, `keywords` is removed from the normalized working record.

For each chat binding:

```js
referenceIds = unique([
  pinned charSlot.refId, // when present
  pinned userSlot.refId, // when present
  ...extraRefIds,
])
```

Auto `charSlot` and auto `userSlot` do not create pool records and therefore do
not migrate into the whitelist. Existing pool aliases carry identity matching.

If slot-level aliases exist on a pinned slot, merge them into the referenced
pool record's aliases before removing the slot. Slot aliases on an auto slot
cannot be assigned safely to a pool record and are not migrated automatically.
The migration should report or log that such aliases were skipped.

Existing message-scoped corrections require translation:

- Pool IDs remain unchanged.
- A special `char` inclusion or exclusion maps to the former pinned char pool
  ID when one exists; otherwise it is dropped.
- A special `user` inclusion or exclusion maps to the former pinned user pool
  ID when one exists; otherwise it is dropped.

This prevents stale special IDs from affecting the new resolver.

## Error Handling

- Missing pool IDs in `referenceIds` are ignored and surfaced as stale entries
  in the whitelist UI when practical.
- Records without images can provide Stage 1 descriptions but cannot become
  Stage 2 refs.
- Records without aliases are valid but manual-only.
- Duplicate aliases within one record are removed case-insensitively.
- Duplicate aliases across records produce an ambiguity and never use
  whitelist order as a tie-breaker.

## Testing

Tests must cover:

- candidates are built only from `referenceIds`;
- no SillyTavern avatar or persona lookup occurs;
- display `name` never triggers prompt matching;
- aliases trigger strict Unicode-aware matching;
- renaming a pool record does not change matching;
- a record without aliases is manual-only;
- duplicate aliases across records fail closed as ambiguous;
- manual include/exclude uses pool IDs;
- `keywords` migrate into aliases without adding `name`;
- pinned slot IDs and slot aliases migrate into the unified whitelist;
- auto slots do not synthesize pool records;
- legacy `char`/`user` corrections are translated or dropped deterministically;
- Stage 1 auto descriptions use aliases rather than names or removed keywords;
- Generate UI has one whitelist and no char/user slot controls.

## Out of Scope

- Automatically creating pool records from SillyTavern avatars.
- Inferring aliases from display names, descriptions, chat text, or an LLM.
- Automatically resolving duplicate aliases.
- Changing the provider-specific reference cap or image materialization logic.
