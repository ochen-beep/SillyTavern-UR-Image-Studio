# Provider-Owned Reference Capability Design

**Date:** 2026-07-17  
**Status:** Proposed  
**Scope:** Reference-image capability resolution for existing image providers

## 1. Goal

Replace the global, model-regex-driven `REF_CAPABILITIES` table with a provider-owned capability contract and a small registry of reusable reference transport protocols.

The redesign must:

- avoid silently blocking reference images merely because a model name is absent from a central whitelist;
- avoid inventing provider limits that are not documented hard limits;
- keep provider-specific routing inside each provider module;
- let a connection explicitly disable references or select a protocol when automatic detection is insufficient;
- preserve the Stage 1/Stage 2 scene pipeline, draft snapshots, reference ordering, retries, image recovery, and existing provider request/response handling;
- retain the application's deliberate UI ceiling of four selected references;
- leave ComfyUI, A1111, and Agnes reference transport deferred and clearly marked as such.

Adding new providers such as fal.ai, Replicate, Black Forest Labs, NVIDIA NIM, xAI, Stability AI, or Recraft is not part of this implementation. The design must make those future integrations additive rather than requiring another global capability matrix.

## 2. Current Problems

### 2.1 A global table owns provider knowledge

`src/providers/base.js` currently defines `REF_CAPABILITIES`. It mixes three separate concerns:

1. whether a provider/model combination can receive references;
2. which wire format should carry them;
3. how many references should be retained.

That table is consumed independently by `src/image-api.js`, `src/providers/openai.js`, and `src/ui/tab-generate.js`. OpenAI routing is therefore resolved more than once and can diverge between UI and request time.

### 2.2 Unknown model names are treated as unsupported

The OpenAI-like entry recognizes a small regex set. A future GPT Image model or a compatible gateway with a different model name loses all references before the provider receives the request.

### 2.3 Soft guidance is represented as a hard transport limit

Some APIs have hard cardinality limits; others describe quality guidance or token/byte constraints. The current table represents all of these as `maxRefs` and slices before dispatch.

### 2.4 Logical reference resolution is confused with delivery policy

A Stage 2 reference set answers: “Which entities does this prompt refer to?” Provider policy answers: “Which of those images can this connection send?” These are different questions. Provider selection must not rewrite the scene snapshot or message-scoped corrections.

## 3. Design Principles

1. **Provider ownership:** a provider module owns automatic support detection and protocol selection.
2. **Protocol reuse:** generic serialization of references is shared, while provider modules continue to own endpoint construction, authentication, request fields, fetch behavior, and response parsing.
3. **One policy resolver:** UI and request dispatch consume the same normalized connection policy.
4. **Logical/delivery separation:** scene resolution remains provider-independent; delivery limits are applied only at UI presentation and request preparation.
5. **No optimistic magic:** a user override may select only a protocol that the provider module declares. Enabling references without a usable protocol is invalid, not a guessed request.
6. **No silent loss:** when selected references exceed the effective delivery maximum, UI and logs state how many will be sent. Unsupported references are not silently discarded.
7. **Backward compatibility:** old connection records default to automatic mode without migration writes.
8. **Bounded scope:** ComfyUI, A1111, and Agnes get explicit deferred capability declarations, not partial implementations.

## 4. Architecture

### 4.1 Provider capability contract

Every image provider module exports a pure function:

```js
export function getReferenceCapabilities(profile) {
    return {
        status: 'supported', // 'supported' | 'unsupported' | 'deferred'
        protocols: ['inline-data'],
        preferredProtocol: 'inline-data',
        maxRefs: null,
        reason: '',
    };
}
```

Contract fields:

- `status`
  - `supported`: automatic mode can send references;
  - `unsupported`: this provider/model is known not to accept references through its implemented routes;
  - `deferred`: the upstream may support reference workflows, but this extension's adapter is intentionally not implemented.
- `protocols`: protocols this provider adapter is actually able to use. This list also bounds explicit connection overrides.
- `preferredProtocol`: provider-owned automatic choice. It may be refined at request time using profile data such as proxy availability.
- `maxRefs`: a documented hard transport limit, or `null` when the provider has no known hard cardinality limit relevant to this extension.
- `reason`: short user-facing explanation for unsupported/deferred states.

The function is deterministic and side-effect free. It may inspect the model, endpoint, and provider options, but does not fetch documentation or probe the API.

### 4.2 Reference protocol registry

Create `src/providers/reference-protocols.js`. It contains pure or narrowly scoped reference serialization helpers:

```js
export const REFERENCE_PROTOCOLS = {
    'multipart-edits': { encodeReferences },
    'multimodal-chat': { encodeReferences },
    'inline-data': { encodeReferences },
    'url-param': { encodeReferences },
};
```

The registry does **not** become a generic HTTP client. Providers continue to own:

- endpoint URLs;
- authorization;
- model, size, quality, and provider-specific body fields;
- `autoFetch`/`fetchWithTimeout` choice;
- response parsing and diagnostics.

The registry owns only reusable transformation of canonical references:

- `multipart-edits`: data URL to named `File` values suitable for `image[]`;
- `multimodal-chat`: OpenAI-compatible `image_url` content parts;
- `inline-data`: Gemini `inlineData` parts;
- `url-param`: conversion/upload required to obtain one public image URL.

This boundary keeps provider behavior stable while preventing serialization logic from being copied into future adapters.

### 4.3 Provider registry

Create or extend a provider registry that maps normalized API types to imported provider modules. The registry replaces capability lookup by string key; it does not replace provider implementation modules.

```js
const IMAGE_PROVIDERS = {
    openai,
    gemini,
    pollinations,
    agnes,
    comfyui,
    a1111,
};
```

`image-api.js` uses the registry for both capability resolution and `generateImage`. This removes the current capability table plus dispatch switch as two independent sources of provider identity.

Unknown API types fail explicitly as they do now.

## 5. Connection Configuration

Add a normalized `referenceOptions` object to image connection metadata:

```js
referenceOptions: {
    mode: 'auto',       // 'auto' | 'off' | 'custom'
    protocol: null,     // required when mode === 'custom'
    maxRefs: null,      // integer 1..MAX_REFS, or null
}
```

### 5.1 Modes

- `auto`: use the provider's capability result and preferred protocol.
- `off`: do not send references for this connection.
- `custom`: explicitly select one of the protocols declared by that provider module. This is the clean replacement for a vague `force-on`: the request can be constructed only when its wire protocol is known.

A `custom` protocol outside the provider's declared `protocols` is invalid and is rejected by normalization/UI validation. Deferred providers declare no protocols, so they cannot be force-enabled until their adapter exists.

### 5.2 Maximum override

`referenceOptions.maxRefs` is a user-selected ceiling, not a claim about upstream capability. It may reduce the number sent, but it does not enlarge the application ceiling or a known provider hard limit.

Normalization rules:

- non-integer, zero, negative, or non-finite values become `null`;
- values above `MAX_REFS` are clamped to `MAX_REFS`;
- old records without `referenceOptions` read as `{ mode: 'auto', protocol: null, maxRefs: null }`;
- API keys remain isolated and are unaffected.

## 6. Effective Reference Policy

Create a provider-independent resolver, for example `src/reference-policy.js`:

```js
resolveReferencePolicy(conn, profile) => {
    supported,
    status,
    protocol,
    maxRefs,
    reason,
    source,
}
```

Resolution order:

1. Normalize connection options.
2. Ask the selected provider module for capabilities.
3. If mode is `off`, return unsupported with `maxRefs: 0` and source `connection-off`.
4. If mode is `custom`, validate and use the selected provider-declared protocol.
5. If mode is `auto`, use the provider's status and preferred protocol.
6. Compute the effective maximum as the minimum of:
   - application `MAX_REFS` (4);
   - provider `maxRefs` when it is a positive finite hard limit;
   - connection `maxRefs` when present.
7. A supported result without a valid protocol is converted to unsupported with an explicit configuration reason.

The resolver never guesses a protocol and never mutates the connection.

## 7. Provider Behavior

### 7.1 OpenAI-like

Automatic behavior remains compatible with the current implementation:

- GPT Image models use `multipart-edits` when references are present;
- supported multimodal-chat routes may use `multimodal-chat`, including the existing proxy-related choice;
- generation-only models remain unsupported for references in automatic mode;
- unknown model IDs are not globally rejected: the provider exposes its implemented protocols so the connection can use `custom` mode.

The current two strategy decisions in `image-api.js` and `openai.js` collapse into one provider-owned decision. `/v1/images/generations` remains reference-free.

OpenAI's documentation supports one or more input images on image edits. Because this application intentionally selects at most four references, no speculative larger hard limit is necessary. The provider returns `maxRefs: null`; the application ceiling remains four.

### 7.2 Gemini

Gemini uses `inline-data`. Automatic reference support remains enabled because its image generation request accepts image parts through the same `generateContent` body shape.

Model-aware maximums use documented constraints only where useful:

- `gemini-2.5-flash-image`: effective provider guidance ceiling 3;
- Gemini 3 image models: documented support exceeds the application ceiling, so `maxRefs: null` is sufficient;
- unknown Gemini image models: no invented hard count; application ceiling 4.

The provider's existing endpoint, auth headers, generation config, response diagnostics, and parser remain unchanged. Only construction of inline image parts moves to the protocol encoder.

### 7.3 Pollinations

- `kontext`: `url-param`, hard maximum 1;
- other models: unsupported in automatic mode;
- `url-param` remains an available custom protocol for a connection whose compatible gateway/model uses it.

The existing upload-to-public-URL behavior stays intact and is moved behind the URL protocol adapter. Pollinations continues to build its own request URL and parse its own response.

### 7.4 Agnes, ComfyUI, and A1111

Each provider returns:

```js
{
    status: 'deferred',
    protocols: [],
    preferredProtocol: null,
    maxRefs: 0,
    reason: 'Работа с референсами для этого провайдера временно отложена.',
}
```

Add the same explicit comment in each provider module. No img2img, ControlNet, IPAdapter, workflow mutation, or partial workaround is introduced in this scope.

## 8. Pipeline Preservation

### 8.1 Stage 1 and scene snapshots

Do not add connection/provider data to:

- `buildSceneContextSnapshot`;
- `resolvePromptReferenceContext`;
- `SceneContextSnapshot`;
- generation draft persistence;
- reference corrections.

`stage2Refs` remains the complete logical, ordered reference set selected by aliases and manual corrections. Changing the active image connection must not mutate or invalidate a prompt snapshot.

### 8.2 Materialization

Keep `materializeStage2References` and its current failure semantics. It continues to load the logical Stage 2 references in order and throws if a selected image cannot be loaded.

Provider trimming remains in request preparation. This may materialize up to the application's four references before a provider reduces the set to one, but avoids coupling the pipeline to connection policy or duplicating capability resolution. With `MAX_REFS = 4`, the bounded overhead is preferable to a wider pipeline refactor.

### 8.3 Image request boundary

`generateImageRequest` remains the canonical provider boundary:

1. resolve the connection and API type;
2. construct the profile;
3. resolve one effective reference policy;
4. canonicalize and filter empty references;
5. if unsupported, issue a visible warning and send no references;
6. if over maximum, issue a visible warning and preserve the first `maxRefs` in existing deterministic order;
7. compress only the retained references;
8. pass both retained references and the resolved protocol to the provider;
9. execute the existing retry wrapper and provider `generateImage` path.

The resolved protocol can be added to the profile as immutable request-scoped metadata. Providers do not re-run model regexes independently.

### 8.4 Retries and recovery

No change to:

- `callWithRetry` generation mode;
- timeout semantics;
- abort signal propagation;
- provider result `{ kind, value }` contract;
- `image-download.js` and `image-recovery.js`;
- queue behavior;
- gallery persistence.

Protocol encoding occurs inside the retry callback only when its values cannot be safely reused (for example, request bodies consumed by `fetch`). Canonical compressed references may be reused between attempts.

## 9. UI Behavior

### 9.1 Connection editor

Add a compact “Референсы” subsection to each image connection:

- mode: “Авто”, “Выключены”, “Свой протокол”;
- protocol selector appears only in custom mode and lists only provider-declared protocols;
- optional maximum selector/input from 1 through 4;
- deferred providers show the message that work is temporarily postponed and do not allow custom mode.

Changing API type re-renders these fields without erasing unrelated connection metadata. `providerOptions` and `referenceOptions` remain separate objects.

### 9.2 Generation tab

Both `renderLivePreview` and the fallback cap host use `resolveReferencePolicy` rather than importing provider tables.

- supported: display `N/M`, where `M` is the effective maximum;
- `N > M`: keep the logical selections visible and state that only the first `M` will be sent;
- unsupported/deferred: hide the add picker and show the resolver's explanation;
- switching to a supporting connection restores the picker and existing logical selections;
- no UI action silently deletes corrections or references when the connection changes.

The add picker prevents adding beyond the application ceiling of four. A lower provider ceiling disables further additions once reached but does not delete already selected references, preserving drafts across connection switches.

## 10. Error Handling

- Invalid connection override: configuration error before network activity.
- Unsupported/deferred with selected references: visible UI info plus request-time warning; request proceeds text-only only when this is current established behavior. The warning names the connection/provider and count omitted.
- Provider rejects an automatically/custom selected protocol: preserve and surface the upstream HTTP error; do not silently retry with a different protocol, because that could repeat a paid generation or change semantics.
- Excess references: deterministic first-N selection and one visible warning.
- Protocol encoder failure: provider-specific contextual error, before request when possible.
- Missing registry/provider entry: explicit “unknown API type” error.

## 11. Testing Strategy

### 11.1 Pure policy tests

Test `resolveReferencePolicy` across:

- auto supported, unsupported, and deferred;
- off always wins;
- custom valid/invalid protocol;
- application/provider/connection maximum precedence;
- null provider maximum;
- malformed persisted options;
- old connections without options.

### 11.2 Provider capability tests

- OpenAI GPT Image, multimodal route, generation-only model, unknown model custom availability;
- Gemini 2.5, Gemini 3, unknown Gemini image model;
- Pollinations Kontext versus other models;
- Agnes/ComfyUI/A1111 deferred declarations and empty protocol lists.

### 11.3 Protocol tests

- reference order is preserved;
- role/name instruction still describes only references actually sent;
- multipart creates one named file per retained reference;
- multimodal creates valid image content parts;
- Gemini inline data preserves MIME and base64;
- URL protocol accepts exactly one retained reference and propagates upload failure.

### 11.4 Request-boundary tests

- unsupported references are omitted with a warning;
- excess references are trimmed before compression and provider invocation;
- provider receives the exact resolved protocol;
- no provider resolves strategy a second time;
- retry, signal, and result contracts remain unchanged.

### 11.5 Pipeline regression tests

Retain and run existing:

- scene-first pipeline tests;
- prompt-driven reference resolution tests;
- pool-only resolver tests;
- generation draft and queue tests;
- provider request tests;
- smoke tests.

Add a regression proving that changing active image connection changes delivery policy but does not change `stage2Refs`, corrections, prompt hashes, or stored snapshots.

## 12. Rollout Sequence

1. Add pure protocol registry and tests without wiring it into providers.
2. Add provider capability exports and policy resolver tests.
3. Add connection normalization/persistence and UI fields.
4. Migrate Gemini and Pollinations reference encoding to protocols with provider tests.
5. Collapse OpenAI routing into its provider-owned capability/protocol selection.
6. Wire `image-api.js` to the provider registry and policy resolver.
7. Replace Generate-tab capability lookup with the policy resolver.
8. Mark Agnes, ComfyUI, and A1111 as deferred.
9. Remove `REF_CAPABILITIES` and obsolete tests only after all consumers are migrated.
10. Run targeted tests, full test suite, and smoke tests.

Each step keeps public request and pipeline contracts intact so failures can be isolated.

## 13. Out of Scope

- implementing ComfyUI workflows, A1111 img2img/ControlNet, or Agnes image-to-image;
- adding new cloud providers;
- automatic capability discovery over network probes;
- scraping or periodically downloading provider documentation;
- raising the application selection ceiling above four;
- changing entity matching, corrections, Stage 1 prompts, draft schema, gallery, queue, or recovery behavior;
- fallback from one paid generation protocol to another after an upstream failure.

## 14. Success Criteria

- No `REF_CAPABILITIES` global table or duplicate OpenAI strategy resolver remains.
- Existing Stage 1/Stage 2 reference resolution output is byte-for-byte structurally unchanged for the same input.
- Existing OpenAI, Gemini, and Pollinations request paths keep their endpoint/auth/response behavior.
- UI and request dispatch report the same support status and maximum for a connection.
- Unknown compatible model IDs can be configured through an explicit, provider-declared protocol rather than editing source regexes.
- Unsupported/deferred references are never silently dropped.
- All existing and new tests pass.
